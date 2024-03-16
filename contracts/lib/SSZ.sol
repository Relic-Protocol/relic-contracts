/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "./MerkleTree.sol";

import {byteReverse} from "./Proofs.sol";

/**
 * @title  SSZ
 * @author Theori, Inc.
 * @notice Selected SSZ merkle verification code for Beacon chain data structures
 *
 * @dev    The indices hardcoded in this contract are primarily for the Dencun hardfork.
 *         One exception is verifying execution payload fields, where Capella is also
 *         supported. Also, this contract uses raw merkle indices rather than the
 *         "generalized indices" specified in SSZ.
 *
 */
library SSZ {
    // the total proof length for a historical block summaries proof
    uint256 constant HISTORICAL_SUMMARIES_TREE_DEPTH = 24;

    // the total proof length for a historical block summaries proof
    uint256 constant HISTORICAL_BLOCK_SUMMARIES_PROOF_LENGTH = 32;

    // index of the block_roots merkle root relative to a block root
    uint256 constant STATE_ROOT_INDEX = 3;

    // index of the block_roots field relative to a state root
    uint256 constant BLOCK_ROOTS_INDEX = 5;

    // index of the historical_summaries field relative to a state root
    uint256 constant HISTORICAL_SUMMARIES_INDEX = 27;

    // index of the slot value relative to a block root
    uint256 constant SLOT_INDEX = 0;

    // index of the execution payload relative to a block root
    uint256 constant EXECUTION_PAYLOAD_INDEX = 73;

    // index of the block number in the left subtree of the execution payload
    uint256 constant BLOCK_NUMBER_LEFT_SUBTREE_INDEX = 6;

    // index of the block hash in the right subtree of the execution payload
    uint256 constant BLOCK_HASH_RIGHT_SUBTREE_INDEX = 4;

    /**
     * @notice verify an SSZ merkle proof for `BeaconBlock.body.execution_payload.block_{number,hash}`
     */
    function verifyExecutionPayloadFields(
        bytes32[] calldata proof,
        bytes32 blockRoot,
        bool isCapella
    ) internal view returns (bytes32 blockHash, uint256 blockNumber) {
        if (isCapella) {
            require(proof.length == 15, "invalid proof length");
        } else {
            require(proof.length == 16, "invalid proof length");
        }
        blockHash = proof[0];
        bytes32 blockNumberAsHash = proof[1];
        bytes32 rightSubtreeRoot = MerkleTree.proofRoot(
            BLOCK_HASH_RIGHT_SUBTREE_INDEX,
            blockHash,
            proof[2:5]
        );
        bytes32 leftSubtreeRoot = MerkleTree.proofRoot(
            BLOCK_NUMBER_LEFT_SUBTREE_INDEX,
            blockNumberAsHash,
            proof[5:8]
        );
        bytes32 executionPayloadSubtreeRoot = MerkleTree.combine(leftSubtreeRoot, rightSubtreeRoot);
        // if in capella, we're already at the execution payload root
        // otherwise, we need one extra proof node
        bytes32 computedRoot = MerkleTree.proofRoot(
            isCapella ? EXECUTION_PAYLOAD_INDEX : EXECUTION_PAYLOAD_INDEX << 1,
            executionPayloadSubtreeRoot,
            proof[8:]
        );
        require(computedRoot == blockRoot, "invalid execution proof");

        blockNumber = byteReverse(uint256(blockNumberAsHash));
    }

    /**
     * @notice verify an SSZ merkle proof for `BeaconBlock.state_root`
     */
    function verifyBlockStateRoot(
        bytes32[] calldata proof,
        bytes32 blockRoot
    ) internal view returns (bytes32 stateRoot) {
        require(proof.length == 4, "invalid proof length");
        stateRoot = proof[0];
        bytes32 computedRoot = MerkleTree.proofRoot(STATE_ROOT_INDEX, stateRoot, proof[1:]);
        require(computedRoot == blockRoot, "invalid stateRoot proof");
    }

    /**
     * @notice verify an SSZ merkle proof for `BeaconBlock.slot`
     */
    function verifyBlockSlot(
        bytes32[] calldata proof,
        bytes32 blockRoot
    ) internal view returns (uint256 slot) {
        require(proof.length == 4, "invalid proof length");
        bytes32 slotAsHash = proof[0];
        bytes32 computedRoot = MerkleTree.proofRoot(SLOT_INDEX, slotAsHash, proof[1:]);
        require(computedRoot == blockRoot, "invalid slot proof");
        slot = byteReverse(uint256(slotAsHash));
        require(slot <= type(uint64).max, "invalid slot value");
    }

    /**
     * @notice verifies `state.historical_summaries[index].block_summary_root`
     */
    function verifyHistoricalBlockSummary(
        bytes32[] calldata proof,
        uint256 index,
        bytes32 stateRoot
    ) internal view returns (bytes32 historicalBlockSummary) {
        // proof length is an upper bound in this case, see below
        require(proof.length <= HISTORICAL_BLOCK_SUMMARIES_PROOF_LENGTH, "proof too long");

        historicalBlockSummary = proof[0];
        bytes32 historicalSummary = MerkleTree.combine(historicalBlockSummary, proof[1]);
        bytes32[] calldata topProof = proof[2:8];

        bytes32 intermediate = MerkleTree.proofRoot(
            index,
            historicalSummary,
            proof[8:]
        );

        // any missing proof nodes are implicit "default" values on the right side of the tree
        uint256 numImplicitNodes = HISTORICAL_BLOCK_SUMMARIES_PROOF_LENGTH - proof.length;

        // compute the defaultValue for our current depth
        bytes32 defaultValue = bytes32(0);
        for (uint256 i = 0; i < HISTORICAL_SUMMARIES_TREE_DEPTH - numImplicitNodes; i++) {
            defaultValue = MerkleTree.combine(defaultValue, defaultValue);
        }

        // compute the historical_summaries data root assuming default value
        bytes32 listDataRoot = MerkleTree.rootWithDefault(
            numImplicitNodes,
            intermediate,
            defaultValue
        );

        // finally, compute the overall state root
        bytes32 computedRoot = MerkleTree.proofRoot(
            HISTORICAL_SUMMARIES_INDEX << 1, // one extra proof node on the right for the list length
            listDataRoot,
            topProof
        );
        require(computedRoot == stateRoot, "invalid summary proof");
    }

    /**
     * @notice verifies `state.block_roots[index]`
     */
    function verifyRelativeBlockRoot(
        bytes32[] calldata proof,
        uint256 index,
        bytes32 stateRoot
    ) internal view returns (bytes32 blockRoot) {
        require(proof.length == 19, "invalid proof length");
        blockRoot = proof[0];
        bytes32 vectorRoot = MerkleTree.proofRoot(
            index,
            blockRoot,
            proof[1:14]
        );
        bytes32 computedRoot = MerkleTree.proofRoot(
            BLOCK_ROOTS_INDEX,
            vectorRoot,
            proof[14:]
        );
        require(computedRoot == stateRoot, "invalid relative proof");
    }

    /**
     * @notice verify an SSZ merkle proof for a Vector[Root, SLOTS_PER_HISTORICAL_ROOT]
     * @dev intended to be used with block summaries, i.e. `BeaconState.block_roots`
     */
    function verifySummaryIndex(
        bytes32[] calldata proof,
        uint256 index,
        bytes32 summaryRoot
    ) internal view returns (bytes32 blockRoot) {
        require(proof.length == 14, "invalid proof length");
        blockRoot = proof[0];
        bytes32 computedRoot = MerkleTree.proofRoot(index, blockRoot, proof[1:]);
        require(computedRoot == summaryRoot, "invalid summary proof");
    }
}
