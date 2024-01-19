/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./provers/StateVerifier.sol";
import "./lib/CoreTypes.sol";
import "./lib/MerkleTree.sol";
import "./interfaces/IProxyBlockHistory.sol";
import "./interfaces/IReliquary.sol";
import "./interfaces/IRecursiveVerifier.sol";

/**
 * @title ProxyBlockHistory
 * @author Theori, Inc.
 * @notice ProxyBlockHistory allows trustless and cheap verification of any
 *         historical L1 block hash on an L2 or side-chain. Using a trusted L1
 *         block hash source, we use storage proofs to extract and store the L1
 *         BlockHistory's stored merkle roots.
 * @dev On L2s, these L1 block hashes are trustlessly sent from the L1 itself.
 *      Hence on L2s we inherit the fully trustlessness of the L1 BlockHistory.
 */
contract ProxyBlockHistory is Ownable, StateVerifier, IProxyBlockHistory {
    // depth of the merkle trees whose roots we store in storage
    uint256 private constant MERKLE_TREE_DEPTH = 13;
    uint256 private constant BLOCKS_PER_CHUNK = 1 << MERKLE_TREE_DEPTH;

    /// @dev address of the reliquary, immutable
    address public immutable reliquary;

    /// @dev the address expected to send the trusted block hashes
    address public immutable messenger;

    /// @dev the address of the L1 block history contract
    address public immutable l1BlockHistory;

    /// @dev the base slot of the merkleRoots map in the L1 contract
    bytes32 public immutable merkleRootsSlot;

    /// @dev the trusted block hashes imported by the messenger
    mapping(uint256 => bytes32) private trusted;

    /// @dev merkle roots of block chunks, proven via storage proofs of the L1
    mapping(uint256 => bytes32) private merkleRoots;

    event TrustedBlockHash(uint256 number, bytes32 blockHash);

    event ImportMerkleRoot(uint256 indexed index, bytes32 merkleRoot);

    enum ProofType {
        Merkle,
        Trusted
    }

    struct ImportMerkleRootsProof {
        uint256 index;
        uint256 numRoots;
        bytes header;
        bytes accountProof;
        bytes32[] slots;
        bytes proofNodes;
        bytes slotProofs;
    }

    constructor(
        address _reliquary,
        address _messenger,
        address _l1BlockHistory,
        bytes32 _merkleRootsSlot
    ) Ownable() StateVerifier(address(this), IReliquary(_reliquary)) {
        reliquary = _reliquary;
        messenger = _messenger;
        l1BlockHistory = _l1BlockHistory;
        merkleRootsSlot = _merkleRootsSlot;
    }

    function parseImportMerkleRootsProof(bytes calldata proof)
        internal
        pure
        returns (ImportMerkleRootsProof calldata res)
    {
        assembly {
            res := proof.offset
        }
    }

    /**
     * @notice Checks if the given block number + hash is stored as a trusted
     *         block hash.
     *
     * @param num the block number to check
     * @param hash the block hash to check
     */
    function validTrustedBlockHash(bytes32 hash, uint256 num) internal view returns (bool) {
        return (hash != bytes32(0) && trusted[num] == hash);
    }

    /**
     * @notice Checks if the given block number + hash exists in a commited
     *         merkle tree.
     *
     * @param num the block number to check
     * @param hash the block hash to check
     * @param encodedProof the encoded merkle proof
     * @return the validity
     */
    function validBlockHashWithMerkle(
        bytes32 hash,
        uint256 num,
        bytes calldata encodedProof
    ) internal view returns (bool) {
        bytes32 merkleRoot = merkleRoots[num / BLOCKS_PER_CHUNK];
        if (merkleRoot == 0) {
            return false;
        }
        bytes32[] calldata proofHashes = parseMerkleProof(encodedProof);
        if (proofHashes.length != MERKLE_TREE_DEPTH) {
            return false;
        }
        return MerkleTree.validProof(merkleRoot, num % BLOCKS_PER_CHUNK, hash, proofHashes);
    }

    function _importTrustedHash(uint256 number, bytes32 hash) internal {
        emit TrustedBlockHash(number, hash);
        trusted[number] = hash;
    }

    /**
     * @notice Import a trusted block hash from the messenger
     * @param number the block number to import
     * @param hash the block hash
     */
    function importTrustedHash(uint256 number, bytes32 hash) external {
        require(msg.sender == messenger, "only the L1 messenger can import trusted block hashes");
        _importTrustedHash(number, hash);
    }

    /**
     * @notice Imports new merkle roots from the L1 using storage proofs
     * @param encoded the encoded ImportMerkleRootsProof
     */
    function importRoots(bytes calldata encoded) external {
        ImportMerkleRootsProof calldata proof = parseImportMerkleRootsProof(encoded);
        uint256 index = proof.index;

        // first validate the block, ensuring that the rootHash is valid
        (bytes32 blockHash, ) = CoreTypes.getBlockHeaderHashAndSize(proof.header);
        CoreTypes.BlockHeaderData memory head = CoreTypes.parseBlockHeader(proof.header);
        require(validTrustedBlockHash(blockHash, head.Number), "Not a trusted block");

        (bool exists, CoreTypes.AccountData memory acc) = verifyAccount(
            l1BlockHistory,
            proof.accountProof,
            head.Root
        );
        require(exists, "l1BlockHistory doesn't exist at block");

        BytesCalldata[] memory values = verifyMultiStorageSlot(
            proof.proofNodes,
            proof.slots,
            proof.slotProofs,
            acc.StorageRoot
        );

        for (uint256 i = 0; i < proof.slots.length; i++) {
            require(
                proof.slots[i] == keccak256(abi.encodePacked(index + i, merkleRootsSlot)),
                "Unexpected slot"
            );

            BytesCalldata value = values[i];
            bytes32 root = bytes32(value.convert()) >> (256 - 8 * value.length());

            require(root != bytes32(0), "Cannot import uninitialized merkle root");

            merkleRoots[index + i] = root;
            emit ImportMerkleRoot(index + i, root);
        }
    }

    /**
     * @notice Checks if a block hash is valid. A proof is required unless the
     *         block is current (accesible in the EVM). If the target block has
     *         no commited merkle root, the proof must contain a SNARK proof.
     *
     * @param hash the hash to check
     * @param num the block number for the alleged hash
     * @param proof the merkle witness or SNARK proof (if needed)
     * @return the validity
     */
    function _validBlockHash(
        bytes32 hash,
        uint256 num,
        bytes calldata proof
    ) internal view returns (bool) {
        ProofType typ;
        (typ, proof) = parseProofType(proof);
        if (typ == ProofType.Trusted) {
            return validTrustedBlockHash(hash, num);
        } else if (typ == ProofType.Merkle) {
            return validBlockHashWithMerkle(hash, num, proof);
        } else {
            revert("invalid proof type: only Merkle proofs supported on L2s");
        }
    }

    /**
     * @notice Checks if a block hash is correct. A proof is required unless the
     *         block is current (accesible in the EVM). If the target block has
     *         no commited merkle root, the proof must contain a SNARK proof.
     *         Reverts if block hash or proof is invalid.
     *
     * @param hash the hash to check
     * @param num the block number for the alleged hash
     * @param proof the merkle witness or SNARK proof (if needed)
     */
    function validBlockHash(
        bytes32 hash,
        uint256 num,
        bytes calldata proof
    ) external view returns (bool) {
        require(msg.sender == reliquary || msg.sender == owner());
        return _validBlockHash(hash, num, proof);
    }

    /**
     * @notice Parses a proof type and proof from the encoded proof
     *
     * @param proof the encoded proof
     * @return typ the proof type (SNARK or Merkle)
     * @return proof the remaining encoded proof
     */
    function parseProofType(bytes calldata encodedProof)
        internal
        pure
        returns (ProofType typ, bytes calldata proof)
    {
        require(encodedProof.length > 0, "cannot parse proof type");
        typ = ProofType(uint8(encodedProof[0]));
        proof = encodedProof[1:];
    }

    /**
     * @notice Parses a merkle inclusion proof from the bytes
     *
     * @param proof the encoded merkle inclusion proof
     * @return result the array of proof hashes
     */
    function parseMerkleProof(bytes calldata proof)
        internal
        pure
        returns (bytes32[] calldata result)
    {
        require(proof.length % 32 == 0);
        require(proof.length >= 32);

        // solidity doesn't support getting calldata outputs from abi.decode
        // but we can decode it; calldata arrays are just (offset,length)
        assembly {
            result.offset := add(proof.offset, 0x20)
            result.length := calldataload(proof.offset)
        }
    }
}
