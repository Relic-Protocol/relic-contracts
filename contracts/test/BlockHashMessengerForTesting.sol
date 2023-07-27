/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "../interfaces/IProxyBlockHistory.sol";

/**
 * @title BlockHashMessengerForTesting
 * @author Theori, Inc.
 * @notice Accepts arbitrary merkle roots and sends them to an L2 BlockHistory.
 *         This contract is abstract so different message passing logic can be
 *         impelemented for each L2.
 */
abstract contract BlockHashMessengerForTesting {
    function _sendMessage(
        address destination,
        bytes calldata params,
        bytes memory message
    ) internal virtual;

    function sendBlockHashForTesting(
        address destination,
        bytes calldata params,
        uint256 number,
        bytes32 blockHash
    ) external payable {
        _sendMessage(
            destination,
            params,
            abi.encodeWithSelector(IProxyBlockHistory.importTrustedHash.selector, number, blockHash)
        );
    }
}
