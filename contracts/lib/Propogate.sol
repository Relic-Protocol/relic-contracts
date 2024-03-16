/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

library Propogate {
    /**
    * @notice propogates the current calldata to the destination
    *         via a staticcall() and returns or reverts accordingly
    * @dev this is much cheaper than manually building the calldata again
    */
    function staticcall(address destination) internal view {
        assembly {
            // we are not returning to solidity, so we can take ownership of all memory
            calldatacopy(0, 0, calldatasize())
            let success := staticcall(gas(), destination, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            // Depending on the success, either revert or return
            switch success
            case 0 {
                // End execution and revert state changes
                revert(0, returndatasize())
            }
            default {
                // Return data with length of size at pointers position
                return(0, returndatasize())
            }
        }
    }
}
