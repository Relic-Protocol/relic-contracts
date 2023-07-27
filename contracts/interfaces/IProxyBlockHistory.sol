/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "./IBlockHistory.sol";

/**
 * @title Block history provider
 * @author Theori, Inc.
 * @notice IBlockHistory provides a way to verify a blockhash
 */

interface IProxyBlockHistory is IBlockHistory {
    /**
     * @notice Import a trusted block hash from the messenger
     * @param number the block number to import
     * @param hash the block hash
     */
    function importTrustedHash(uint256 number, bytes32 hash) external;
}
