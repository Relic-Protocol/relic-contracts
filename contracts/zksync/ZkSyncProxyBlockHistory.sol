/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity ^0.8.0;

import "@matterlabs/zksync-contracts/l2/contracts/vendor/AddressAliasHelper.sol";
import "../ProxyBlockHistory.sol";

/**
 * @title ZkSyncProxyBlockHistory
 * @author Theori, Inc.
 * @notice A wrapper around ProxyBlockHistory which translates the messenger address
 *         according to the ZkSync aliasing rules.
 */
contract ZkSyncProxyBlockHistory is ProxyBlockHistory {
    constructor(
        address reliquary,
        address messenger,
        address l1BlockHistory,
        bytes32 merkleRootsSlot
    )
        ProxyBlockHistory(
            reliquary,
            AddressAliasHelper.applyL1ToL2Alias(messenger),
            l1BlockHistory,
            merkleRootsSlot
        )
    {}
}
