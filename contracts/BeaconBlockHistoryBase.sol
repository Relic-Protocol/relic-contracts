/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2024
/// All rights reserved

pragma solidity >=0.8.0;

import "./lib/SSZ.sol";
import "./lib/CoreTypes.sol";

/**
 * @title BeaconBlockHistoryBase
 * @author Theori, Inc.
 * @notice BeaconBlockHistoryBase implements common logic for Beacon block verification.
 *
 * @notice Logic which is specific to L1 or L2 is implemented in subcontracts.
 */
abstract contract BeaconBlockHistoryBase {
    uint256 private constant SLOTS_PER_HISTORICAL_ROOT = 1 << 13;

    /// @dev A mapping from slot number to the
    //       `historical_summary.block_summary_root`
    mapping(uint256 => bytes32) private blockSummaries;

    /// @dev the slot of the Capella fork on this network
    uint256 public immutable CAPELLA_SLOT;

    /// @dev the slot of the Dencun fork on this network
    uint256 public immutable DENEB_SLOT;

    event ImportBlockSummary(uint256 indexed slot, bytes32 summary);

    /// @dev types of beacon block proofs
    enum BeaconProofType {
        Oracle,
        Summary,
        Relative,
        Header
    }

    /// @dev a proof of a `HistoricalSummary.block_summary_root` at some slot
    struct HistoricalBlockSummaryProof {
        bytes beaconBlockProof;
        bytes32[] slotProof;
        bytes32[] stateRootProof;
        uint256 blockSummaryIndex;
        bytes32[] blockSummaryProof;
    }

    /// @dev a proof that a particular beacon block root is valid by reference to a historical summary
    struct SummaryBlockRootProof {
        /// @dev the proof to verify block summary
        bytes summaryProof;
        /// @dev the index of the slot in the summary
        uint256 index;
        /// @dev the summary merkle proof
        bytes32[] indexProof;
    }

    /// @dev a proof that a particular beacon block root is valid by querying the oracle
    struct OracleBlockRootProof {
        /// @dev the timestamp to query the oracle with
        uint256 timestamp;
    }

    /// @dev a proof that a particular beacon block root is valid by reference to `BeaconState.block_roots`
    ///      at some other beacon block
    struct RelativeBlockRootProof {
        /// @dev the proof of the base block root
        bytes baseProof;
        /// @dev the proof the base block's state root
        bytes32[] stateRootProof;
        /// @dev the index in the `block_roots` buffer
        uint256 index;
        /// @dev the proof of the entry in the state's `block_roots` vector
        bytes32[] relativeRootProof;
    }

    /// @dev a proof that a particular beacon block root is valid by reference to the
    ///      `parent_beacon_block_root` field of a verifiable execution block header
    struct HeaderBlockRootProof {
        /// @dev the raw execution block header
        bytes header;
        /// @dev the proof of the header's validity (if needed)
        bytes proof;
    }

    /// @dev a proof that a particular execution block is valid
    struct ExecutionBlockProof {
        /// @dev the proof of the beacon block
        bytes beaconProof;
        /// @dev the proof of the block's slot
        bytes32[] slotProof;
        /// @dev the proof of the exeuction payload in the beacon block
        bytes32[] payloadProof;
    }

    constructor(
        uint256 _CAPELLA_SLOT,
        uint256 _DENEB_SLOT
    ) {
        CAPELLA_SLOT = _CAPELLA_SLOT;
        DENEB_SLOT = _DENEB_SLOT;
    }

    function _castHistoricalBlockSummaryProof(
        bytes calldata rawProof
    ) internal pure returns (HistoricalBlockSummaryProof calldata proof) {
        assembly {
            proof := rawProof.offset
        }
    }

    function _castOracleBlockRootProof(
        bytes calldata rawProof
    ) internal pure returns (OracleBlockRootProof calldata proof) {
        assembly {
            proof := rawProof.offset
        }
    }

    function _castSummaryBlockRootProof(
        bytes calldata rawProof
    ) internal pure returns (SummaryBlockRootProof calldata proof) {
        assembly {
            proof := rawProof.offset
        }
    }

    function _castRelativeBlockRootProof(
        bytes calldata rawProof
    ) internal pure returns (RelativeBlockRootProof calldata proof) {
        assembly {
            proof := rawProof.offset
        }
    }

    function _castHeaderBlockRootProof(
        bytes calldata rawProof
    ) internal pure returns (HeaderBlockRootProof calldata proof) {
        assembly {
            proof := rawProof.offset
        }
    }

    function _castExecutionBlockProof(
        bytes calldata rawProof
    ) internal pure returns (ExecutionBlockProof calldata proof) {
        assembly {
            proof := rawProof.offset
        }
    }

    /**
     * @notice verifies and caches a `HistoricalSummary` root at some beacon block
     * @param proof the proof required to access the root
     * @dev requires the slot to be aligned to SLOTS_PER_HISTORICAL_ROOT
     */
    function cacheBlockSummary(bytes calldata proof) external {
        (uint256 slot, bytes32 blockSummary) = _verifyBlockSummary(proof);
        blockSummaries[slot] = blockSummary;
        emit ImportBlockSummary(slot, blockSummary);
    }

    /**
     * @notice returns a cached block summary
     * @param slot the slot for the summary
     */
    function _getBlockSummary(uint256 slot) internal view returns (bytes32 result) {
        result = blockSummaries[slot];
    }

    /**
     * @dev either accesses a cached historical block summary or verifies a proof of one
     * @dev If verifying a proof, it first verifies that a beacon block root is valid, and then
     *      verifies the SSZ proof of `BeaconState.historical_summaries[idx].block_summary_root`.
     * @return slot the slot number of this historical summary
     * @return blockSummary the block summary root
     */
    function _verifyBlockSummary(
        bytes calldata rawProof
    ) internal view returns (uint256 slot, bytes32 blockSummary) {
        // check if the proof references a cached summary
        if (rawProof.length == 32) {
            // load the cached summary
            slot = uint256(bytes32(rawProof));
            blockSummary = blockSummaries[slot];
            require(blockSummary != bytes32(0), "block summary not cached");
        } else {
            HistoricalBlockSummaryProof calldata proof = _castHistoricalBlockSummaryProof(rawProof);

            // first verify a beacon block root
            bytes32 blockRoot = _verifyBeaconBlockRoot(proof.beaconBlockProof);
            uint256 baseSlot = SSZ.verifyBlockSlot(proof.slotProof, blockRoot);

            // now access the block's state root
            bytes32 stateRoot = SSZ.verifyBlockStateRoot(proof.stateRootProof, blockRoot);

            // finally, extract the block summary field from the target state
            blockSummary = SSZ.verifyHistoricalBlockSummary(
                proof.blockSummaryProof,
                proof.blockSummaryIndex,
                stateRoot
            );

            // compute the slot for this summary - note that summaries started at Capella
            slot = CAPELLA_SLOT + SLOTS_PER_HISTORICAL_ROOT * (proof.blockSummaryIndex + 1);

            // ensure the base slot actually contains this summary
            require(baseSlot >= slot, "index out of bounds");
        }
    }

    /**
     * @dev uses a beacon block summary proof to verify a block root
     */
    function _verifySummaryBlockRoot(
        bytes calldata rawProof
    ) internal view returns (bytes32 blockRoot) {
        SummaryBlockRootProof calldata proof = _castSummaryBlockRootProof(rawProof);
        // otherwise use a block summary to access the block root
        (uint256 baseSlot, bytes32 blockSummary) = _verifyBlockSummary(proof.summaryProof);
        assert(baseSlot % SLOTS_PER_HISTORICAL_ROOT == 0);

        uint256 index = proof.index;
        require(index < SLOTS_PER_HISTORICAL_ROOT, "invalid index");
        blockRoot = SSZ.verifySummaryIndex(
            proof.indexProof,
            index,
            blockSummary
        );
    }

    /**
     * @dev uses the `block_roots` vector of another accessible block root
     */
    function _verifyRelativeBlockRoot(
        bytes calldata rawProof
    ) internal view returns (bytes32 blockRoot) {
        RelativeBlockRootProof calldata proof = _castRelativeBlockRootProof(rawProof);

        // first verify the base block root
        blockRoot = _verifyBeaconBlockRoot(proof.baseProof);

        // now access the base block's state root
        bytes32 stateRoot = SSZ.verifyBlockStateRoot(proof.stateRootProof, blockRoot);

        uint256 index = proof.index;
        require(index < SLOTS_PER_HISTORICAL_ROOT, "block_roots index out of bounds");

        // verify the target block root relative to the base block root
        blockRoot = SSZ.verifyRelativeBlockRoot(
            proof.relativeRootProof,
            index,
            stateRoot
        );
        require(blockRoot != bytes32(0), "invalid blockRoot proven");
    }

    /**
     * @dev uses the `parent_beacon_block_root` field of a verifiable execution header
     *      to verify a beacon block root
     */
    function _verifyHeaderBlockRoot(
        bytes calldata rawProof
    ) internal view returns (bytes32 blockRoot) {
        HeaderBlockRootProof calldata proof = _castHeaderBlockRootProof(rawProof);

        // hash and parse the provided header
        bytes32 blockHash = keccak256(proof.header);
        CoreTypes.BlockHeaderData memory header = CoreTypes.parseBlockHeader(proof.header);

        require(
            _validBlockHash(blockHash, header.Number, proof.proof),
            "block hash not valid"
        );

        blockRoot = header.ParentBeaconBlockRoot;
        require(blockRoot != bytes32(0), "header does not contain parent_beacon_block_root");
    }


    /**
     * @dev verifies an execution layer block hash using SSZ merkle proofs.
     */
    function _verifyELBlockData(
        bytes calldata rawProof
    ) internal view returns (bytes32 blockHash, uint256 blockNum) {
        ExecutionBlockProof calldata proof = _castExecutionBlockProof(rawProof);

        // verify the beacon block root is valid
        bytes32 blockRoot = _verifyBeaconBlockRoot(proof.beaconProof);

        // verify the block slot number to determine which hardfork it's from
        uint256 slot = SSZ.verifyBlockSlot(proof.slotProof, blockRoot);
        require(slot >= CAPELLA_SLOT, "slot is before capella fork");
        bool isCapella = slot < DENEB_SLOT;

        // verify the execution header data within it
        (blockHash, blockNum) = SSZ.verifyExecutionPayloadFields(
            proof.payloadProof,
            blockRoot,
            isCapella
        );
    }

    /**
     * @dev verifies an execution layer block hash using SSZ merkle proofs.
     *      Returns true if the data is valid. May either revert or return
     *      false if the proof is invalid.
     */
    function _validBlockHashWithBeacon(
        bytes32 hash,
        uint256 num,
        bytes calldata rawProof
    ) internal view returns (bool) {
        (bytes32 blockHash, uint256 blockNum) = _verifyELBlockData(rawProof);
        // return whether it matches the query
        return hash == blockHash && num == blockNum;
    }

    /**
     * @notice Parses a beacon proof type and proof from the encoded proof
     *
     * @param encodedProof the encoded proof
     * @return typ the proof type
     * @return proof the remaining encoded proof
     */
    function parseBeaconProofType(bytes calldata encodedProof)
        internal
        pure
        returns (BeaconProofType typ, bytes calldata proof)
    {
        require(encodedProof.length > 0, "cannot parse beacon proof type");
        typ = BeaconProofType(uint8(encodedProof[0]));
        proof = encodedProof[1:];
    }

    function _verifyBeaconBlockRoot(
        bytes calldata proof
    ) internal virtual view returns (bytes32 blockRoot);

    /**
     * @notice Checks if an execution block hash is valid.
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
    ) internal virtual view returns (bool);
}
