/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2024
/// All rights reserved

pragma solidity >=0.8.0;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./BeaconBlockHistoryBase.sol";
import "./lib/Propogate.sol";
import "./interfaces/IBlockHistory.sol";
import "./interfaces/IBeaconBlockHistory.sol";

/**
 * @title ProxyBeaconBlockHistory
 * @author Theori, Inc.
 * @notice ProxyBeaconBlockHistory allows trustless and cheap verification of any post-Dencun
 *         L1 beacon block root from some L2 chain. Since the beacon blocks contain the
 *         execution block headers, this also enables verifying those execution block hashes.
 *
 * @notice By propogating some queries to Relic's original ProxyBlockHistory contract,
 *         this contract enables cheap verification of *all* L1 execution block hashes
 *         back to genesis.
 *
 * @dev This works by leveraging the `parent_beacon_block_root` header field introduced
 *      in EIP-4788: https://eips.ethereum.org/EIPS/eip-4788#block-structure-and-validity.
 *
 *      Given access to a recent execution block header, we parse the `parent_beacon_block_root`.
 *      Then, using an SSZ merkle proof of the `BeaconState.block_roots` and/or the
 *      `BeaconState.historical_summaries` elements, we can verifiably access beacon block root
 *      since the Capella hardfork.
 *
 *      To reduce redundancy, this contract supports caching each value of the
 *      `historical_sumaries` list. Given this cached root, block proofs can be generated
 *      using only `BeaconBlock` roots (and data), which are easily accessible.
 *
 *      Execution block information can then be verified with merkle proofs of
 *      the `BeaconBlock.body.execution_payload.block_{number,hash}` fields.
 *
 * @dev Note: this contract should be extended to provide a mechanism to import an L1 blockhash
 *      in a trustless way. This could be via a trustless L1 -> L2 message, or by a built-in
 *      L1 Block oracle query, depending on the L2 network.
 */
contract ProxyBeaconBlockHistory is AccessControl, BeaconBlockHistoryBase, IBlockHistory, IBeaconBlockHistory {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant QUERY_ROLE = keccak256("QUERY_ROLE");

    /// @dev address of the reliquary, immutable
    address public immutable reliquary;

    /// @dev mapping of precomitted execution block hashes
    mapping(uint256 => bytes32) private precomittedBlockHashes;

    /// @dev the blockHistory which stores the data before the Dencnun fork
    address public immutable preDencunBlockHistory;

    /// @dev the first block number handled by this contract
    uint256 public immutable UPGRADE_BLOCK;

    event PrecomittedBlock(uint256 indexed blockNum, bytes32 blockHash);

    /// @dev types of block proofs supported by this and prior contracts
    enum ProofType {
        Merkle, // legacy, not supported in this contract
        SNARK,  // legacy, not supported in this contract
        Precomitted,
        Beacon
    }

    constructor(
        address _reliquary,
        address _preDencunBlockHistory,
        uint256 _CAPELLA_SLOT,
        uint256 _DENEB_SLOT,
        uint256 _UPGRADE_BLOCK
    ) BeaconBlockHistoryBase(_CAPELLA_SLOT, _DENEB_SLOT) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(ADMIN_ROLE, msg.sender);
        _setupRole(QUERY_ROLE, msg.sender);

        reliquary = _reliquary;
        preDencunBlockHistory = _preDencunBlockHistory;
        UPGRADE_BLOCK = _UPGRADE_BLOCK;
    }

    /**
     * @notice Checks if the block is a valid precomitted block.
     *
     * @param hash the alleged block hash
     * @param num the block number
     */
    function _validPrecomittedBlock(bytes32 hash, uint256 num) internal view returns (bool) {
        bytes32 stored = precomittedBlockHashes[num];
        return stored != bytes32(0) && stored == hash;
    }

    function _storeCommittedBlock(uint256 blockNum, bytes32 blockHash) internal {
        require(blockHash != bytes32(0), "invalid blockhash");
        precomittedBlockHashes[blockNum] = blockHash;
        emit PrecomittedBlock(blockNum, blockHash);
    }

    /**
     * @dev implements beacon block root verification for L2
     * @dev supports all proof types except oracle queries
     */
    function _verifyBeaconBlockRoot(
        bytes calldata proof
    ) internal override view returns (bytes32 blockRoot) {
        BeaconProofType typ;
        (typ, proof) = parseBeaconProofType(proof);

        if (typ == BeaconProofType.Summary) {
            return _verifySummaryBlockRoot(proof);
        } else if (typ == BeaconProofType.Relative) {
            return _verifyRelativeBlockRoot(proof);
        } else if (typ == BeaconProofType.Header) {
            return _verifyHeaderBlockRoot(proof);
        } else {
            revert("unsupported proof type");
        }
    }

    /**
     * @notice verifies a beacon block root
     * @param proof the proof of the beacon blcok
     * @return blockRoot the `BeaconBlock` root
     */
    function verifyBeaconBlockRoot(
        bytes calldata proof
    ) external view onlyRole(QUERY_ROLE) returns (bytes32 blockRoot) {
        blockRoot = _verifyBeaconBlockRoot(proof);
    }

    /**
     * @notice Parses a proof type and proof from the encoded proof
     *
     * @param encodedProof the encoded proof
     * @return typ the proof type
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
     * @notice Checks if an execution block hash is valid. A proof is required.
     * @notice if the target block is before the Dencun fork, the query will be propogated
     *         to the pre-Dencun BlockHistory contract.
     *
     * @param hash the hash to check
     * @param num the block number for the alleged hash
     * @param proof the proof (if needed)
     * @return the validity
     */
    function _validBlockHash(
        bytes32 hash,
        uint256 num,
        bytes calldata proof
    ) internal override view returns (bool) {
        // if attempting to verify an unhandled block,
        // propogate the call to the legacy BlockHistory
        if (num < UPGRADE_BLOCK) {
            Propogate.staticcall(preDencunBlockHistory); // does not return
        }

        ProofType typ;
        (typ, proof) = parseProofType(proof);
        if (typ == ProofType.Precomitted) {
            return _validPrecomittedBlock(hash, num);
        } else if (typ == ProofType.Beacon) {
            return _validBlockHashWithBeacon(hash, num, proof);
        } else {
            revert("unsupported proof type");
        }
    }

    /**
     * @notice Checks if a block hash is correct. A proof is required unless the
     *         block is current (accesible in the EVM) or precomitted.
     *         Reverts if proof is invalid.
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
        // optimization: check if sender is reliquary first,
        // so we don't touch storage in the typical path
        require(msg.sender == reliquary || hasRole(QUERY_ROLE, msg.sender));
        return _validBlockHash(hash, num, proof);
    }

    function getBlockSummary(uint256 slot) external view returns (bytes32 result) {
        require(hasRole(QUERY_ROLE, msg.sender) || msg.sender == address(0));
        result = _getBlockSummary(slot);
    }
}
