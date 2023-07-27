/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity ^0.8.0;

import "@matterlabs/zksync-contracts/l1/contracts/zksync/interfaces/IMailbox.sol";
import "./interfaces/IReliquary.sol";
import "./BlockHashMessenger.sol";

/**
 * @title ZkSyncBlockHashMessenger
 * @author Theori, Inc.
 * @notice The L1 messenger contract to send block hashes to zkSync.
 */
contract ZkSyncBlockHashMessenger is BlockHashMessenger {
    address public immutable zkSync;

    constructor(
        IReliquary _reliquary,
        address _blockHistory,
        address _zkSync
    ) BlockHashMessenger(_reliquary, _blockHistory) {
        zkSync = _zkSync;
    }

    function _sendMessage(
        address destination,
        bytes calldata params,
        bytes memory data
    ) internal override {
        (uint256 l2GasLimit, uint256 l2GasPerPubdataByteLimit) = abi.decode(
            params,
            (uint256, uint256)
        );
        IMailbox(zkSync).requestL2Transaction{value: msg.value}(
            destination,
            0,
            data,
            l2GasLimit,
            l2GasPerPubdataByteLimit,
            new bytes[](0),
            msg.sender
        );
    }
}
