/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "../BlockHistory.sol";

/**
 * @title BlockHistoryForTesting
 * @author Theori, Inc.
 * @notice BlockHistory extension to aid in testing. Should never be deployed
 *         in production.
 *
 */
contract BlockHistoryForTesting is BlockHistory {
    constructor(
        uint256[] memory sizes,
        IRecursiveVerifier[] memory verifiers,
        address reliquary
    ) BlockHistory(sizes, verifiers, reliquary) {
        require(block.chainid == 31337, "testing only");
    }

    /**
     * @notice directly sets the parentHash and lastHash; used for testing,
     *         only callable if deployed contract is for testing
     *
     * @param parent the parentHash
     * @param last the lastHash
     */
    function setHashesForTesting(bytes32 parent, bytes32 last) external onlyRole(ADMIN_ROLE) {
        parentHash = parent;
        lastHash = last;
    }

    /**
     * @notice directly sets the earliestRoot; used for testing,
     *         only callable if deployed contract is for testing
     *
     * @param num the new earliestRoot
     */
    function setEarliestRootForTesting(uint256 num) external onlyRole(ADMIN_ROLE) {
        earliestRoot = num;
    }

    /**
     * @notice Stores the merkle roots starting at the index; used for testing,
     *         only callable if deploy contract is for testing
     *
     * @param index the index for the first merkle root
     * @param roots the block merkle roots
     * @param aux the auxiliary roots
     */
    function storeMerkleRootsForTesting(
        uint256 index,
        bytes32[] calldata roots,
        bytes32[] calldata aux
    ) external onlyRole(ADMIN_ROLE) {
        storeMerkleRoots(index, roots, aux);
    }

    /**
     * @notice Same as assertValidBlockHash, except it ignores the feeProvider and
     *         is view; only callable if deployed contract is for testing
     *
     * @param hash the hash to check
     * @param num the block number for the alleged hash
     * @param proof the merkle witness or SNARK proof (if needed)
     */
    function assertValidBlockHashForTesting(
        bytes32 hash,
        uint256 num,
        bytes calldata proof
    ) external view onlyRole(ADMIN_ROLE) {
        require(_validBlockHash(hash, num, proof), "invalid block hash");
    }
}
