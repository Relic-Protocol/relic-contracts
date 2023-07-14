/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

/*
 * @author Theori, Inc.
 */

pragma solidity >=0.8.0;

struct BaseFeeStats {
    uint256 cumulative_1;
    uint256 cumulative_2;
    uint256 cumulative_3;
    uint256 cumulative_4;
}

using BaseFeeStatsOps for BaseFeeStats global;

library BaseFeeStatsOps {
    function eq(BaseFeeStats calldata a, BaseFeeStats calldata b) internal pure returns (bool) {
        return (a.cumulative_1 == b.cumulative_1 &&
            a.cumulative_2 == b.cumulative_2 &&
            a.cumulative_3 == b.cumulative_3 &&
            a.cumulative_4 == b.cumulative_4);
    }
}

/**
 * @notice Small hack to compute sizeof(BaseFeeStats)
 * @dev avoids the need to hardcode this size
 * @dev note that this only works because BaseFeeStats is statically sized
 * @return size
 */
function baseFeeStatsSize() pure returns (uint256 size) {
    BaseFeeStats[2] calldata fakeArr;
    assembly {
        fakeArr := 0
    }
    BaseFeeStats calldata fake = fakeArr[1];
    assembly {
        size := fake
    }
}

/**
 * @notice reads a BaseFeeStats from its encoded form
 * @param words the hash words
 * @return result the parsed base fee stats
 */
function readBaseFeeStats(uint256[] calldata words) pure returns (BaseFeeStats memory result) {
    result = BaseFeeStats(words[0], words[1], words[2], words[3]);
}

/**
 * @notice hashes the base fee stats struct as is done in the ZK-circuits
 * @param stats the input stats
 * @return hash the resulting hash
 */
function hashBaseFeeStats(BaseFeeStats memory stats) view returns (bytes32 hash) {
    uint256 size = baseFeeStatsSize();
    assembly {
        if iszero(staticcall(gas(), 0x2, stats, size, 0x0, 0x20)) {
            revert(0, 0)
        }
        hash := mload(0x0)
    }
}
