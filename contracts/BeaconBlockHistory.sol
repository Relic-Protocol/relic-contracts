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
 * @title BeaconBlockHistory
 * @author Theori, Inc.
 * @notice BeaconBlockHistory allows trustless and cheap verification of any
 *         post-Dencun historical beacon block root. Since the beacon blocks
 *         contain the execution block headers, this also enables verifying
 *         those execution block hashes.
 *
 * @notice By propogating some queries to Relic's original BlockHistory contract,
 *         this contract enables cheap verification of *all* execution block hashes
 *         back to genesis.
 *
 * @dev This works by leveraging the native beacon block hash oracle contract introduced
 *      in EIP-4788: https://eips.ethereum.org/EIPS/eip-4788#block-structure-and-validity.
 *
 *      Recent blocks (< 8191 slots old) can be accessed by directly querying the oracle.
 *      Then, using an SSZ merkle proof of the `BeaconState.historical_summaries` elements,
 *      we can verifiably access beacon block root since the Capella hardfork.
 *
 *      To reduce redundancy, this contract supports caching each value of the
 *      `historical_sumaries` list. Given this cached root, block proofs can be generated
 *      using only `BeaconBlock` roots (and data), which are easily accessible.
 *
 *      Execution block information can then be verified with merkle proofs of
 *      the `BeaconBlock.body.execution_payload.block_{number,hash}` fields.
 */
contract BeaconBlockHistory is AccessControl, BeaconBlockHistoryBase, IBlockHistory, IBeaconBlockHistory {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant QUERY_ROLE = keccak256("QUERY_ROLE");

    /// @dev address of the reliquary, immutable
    address public immutable reliquary;

    /// @dev mapping of precomitted execution block hashes
    mapping(uint256 => bytes32) private precomittedBlockHashes;

    /// @dev the blockHistory which stores the data before the Dencnun fork
    address public immutable preDencunBlockHistory;

    /// @dev the address of the beacon oracle contract on this network
    address public immutable beaconOracleContract;

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
        address _beaconOracleContract,
        uint256 _CAPELLA_SLOT,
        uint256 _DENEB_SLOT,
        uint256 _UPGRADE_BLOCK
    ) BeaconBlockHistoryBase(_CAPELLA_SLOT, _DENEB_SLOT) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(ADMIN_ROLE, msg.sender);
        _setupRole(QUERY_ROLE, msg.sender);

        reliquary = _reliquary;
        preDencunBlockHistory = _preDencunBlockHistory;
        beaconOracleContract = _beaconOracleContract;
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

    /**
     * @notice Determines if the block is accessible via the BLOCKHASH opcode
     *
     * @param num the block number
     */
    function _isBlockhashEVMAccessible(uint256 num) internal view returns (bool) {
        return num < block.number && block.number - num <= 256;
    }

    /**
     * @notice Checks if the block is a current block (defined as being
     *         accessible in the EVM, i.e. <= 256 blocks old) and that the hash
     *         is correct.
     *
     * @param hash the alleged block hash
     * @param num the block number
     * @return the validity
     */
    function _validCurrentBlock(bytes32 hash, uint256 num) internal view returns (bool) {
        // the block hash must be accessible in the EVM and match
        return _isBlockhashEVMAccessible(num) && (blockhash(num) == hash);
    }

    function _storeCommittedBlock(uint256 blockNum, bytes32 blockHash) internal {
        require(blockHash != bytes32(0), "invalid blockhash");
        precomittedBlockHashes[blockNum] = blockHash;
        emit PrecomittedBlock(blockNum, blockHash);
    }

    /**
     * @notice commits to a recent execution block header
     * @notice reverts if the blockhash is not natively accessible
     *
     * @param blockNum the block number to commit
     */
    function commitRecent(uint256 blockNum) external {
        require(_isBlockhashEVMAccessible(blockNum), "target block not in EVM");
        _storeCommittedBlock(blockNum, blockhash(blockNum));
    }

    /**
     * @dev queries the oracle for a beacon block root
     * @dev the returned root will be the parent of the block at the given timestamp
     */
    function _queryBeaconRootOracle(
        uint256 nextBlockTimestamp
    ) internal view returns (bytes32 blockRoot) {
        address oracle = beaconOracleContract;
        assembly {
            mstore(0, nextBlockTimestamp)
            let success := staticcall(gas(), oracle, 0, 0x20, 0, 0x20)
            switch success
            case 0 {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            default {
                blockRoot := mload(0)
            }
        }
    }

    /**
     * @dev uses the oracle to query for a beacon block root
     */
    function _verifyOracleBlockRoot(
        bytes calldata rawProof
    ) internal view returns (bytes32 blockRoot) {
        OracleBlockRootProof calldata proof = _castOracleBlockRootProof(rawProof);
        // if no summary proof is provided, use the oracle to access a recent block root
        blockRoot = _queryBeaconRootOracle(proof.timestamp);
    }

    /**
     * @dev implements beacon block root verification for L1
     * @dev supports all proof types, including oracle queries
     */
    function _verifyBeaconBlockRoot(
        bytes calldata proof
    ) internal override view returns (bytes32 blockRoot) {
        BeaconProofType typ;
        (typ, proof) = parseBeaconProofType(proof);

        if (typ == BeaconProofType.Summary) {
            return _verifySummaryBlockRoot(proof);
        } else if (typ == BeaconProofType.Oracle) {
            return _verifyOracleBlockRoot(proof);
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
     * @notice Checks if an execution block hash is valid. A proof is required unless
     *         the block is current (accesible in the EVM) or precomitted.
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
        require(num < block.number, "given block is current or future block");

        if (_validCurrentBlock(hash, num)) {
            return true;
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
