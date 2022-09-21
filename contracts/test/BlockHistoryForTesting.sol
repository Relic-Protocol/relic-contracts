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
    function setHashesForTesting(bytes32 parent, bytes32 last) external onlyOwner {
        parentHash = parent;
        lastHash = last;
    }

    /**
     * @notice directly sets the earliestRoot; used for testing,
     *         only callable if deployed contract is for testing
     *
     * @param num the new earliestRoot
     */
    function setEarliestRootForTesting(uint256 num) external onlyOwner {
        earliestRoot = num;
    }

    /**
     * @notice Stores the merkle roots starting at the index; used for testing,
     *         only callable if deploy contract is for testing
     *
     * @param index the index for the first merkle root
     * @param roots the merkle roots
     */
    function storeMerkleRootsForTesting(uint256 index, bytes32[] calldata roots)
        external
        onlyOwner
    {
        storeMerkleRoots(index, roots);
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
    ) external view onlyOwner {
        require(_validBlockHash(hash, num, proof), "invalid block hash");
    }
}
