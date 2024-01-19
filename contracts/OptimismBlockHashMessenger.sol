/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity ^0.8.0;

import "./interfaces/IReliquary.sol";
import "./BlockHashMessenger.sol";

// OptimismPortal low-level L1->L2 messaging interface
interface IPortal {
    function depositTransaction(
        address _to,
        uint256 _value,
        uint64 _gasLimit,
        bool _isCreation,
        bytes calldata _data
    ) external payable;
}

/**
 * @title OptimismBlockHashMessenger
 * @author Theori, Inc.
 * @notice The L1 messenger contract to send block hashes to Optimism.
 *         Also works for compatible Optimism forks, such as Base.
 */
contract OptimismBlockHashMessenger is BlockHashMessenger {
    address public immutable portal;

    constructor(
        IReliquary _reliquary,
        address _blockHistory,
        address _portal
    ) BlockHashMessenger(_reliquary, _blockHistory) {
        portal = _portal;
    }

    function _sendMessage(
        address destination,
        bytes calldata params,
        bytes memory data
    ) internal override {
        uint64 gasLimit = abi.decode(params, (uint64));
        require(msg.value == 0, "Optimism messaging does not pay fee via msg.value");
        IPortal(portal).depositTransaction(
            destination,
            0,
            gasLimit,
            false,
            data
        );
    }
}
