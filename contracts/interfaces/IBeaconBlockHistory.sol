/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "./IBlockHistory.sol";

/**
 * @title Beacon Block history provider
 * @author Theori, Inc.
 * @notice IBeaconBlockHistory provides a way to verify beacon block roots as well as execution block hashes
 */

interface IBeaconBlockHistory is IBlockHistory {
    function UPGRADE_BLOCK() external view returns (uint256 blockNum);

    /**
     * @notice verifies a beacon block root
     * @param proof the proof of the beacon blcok
     * @return blockRoot the `BeaconBlock` root
     */
    function verifyBeaconBlockRoot(
        bytes calldata proof
    ) external view returns (bytes32 blockRoot);

    /**
     * @notice gets the cached block summary for the given slot (if it exists)
     * @param slot the slot number to query
     * @return result the cached block summary (or bytes32(0) if it is not cached)
     */
    function getBlockSummary(uint256 slot) external view returns (bytes32 result);
}
