/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity ^0.8.0;

import "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import "../ProxyBlockHistory.sol";

interface IL1Block {
    function hash() external view returns (bytes32);
    function number() external view returns (uint64);
}

/**
 * @title OptimismProxyBlockHistory
 * @author Theori, Inc.
 * @notice A wrapper around ProxyBlockHistory which translates the messenger address
 *         according to the Optimism aliasing rules and allows direct committing of
 *         the accessible L1 block data.
 */
contract OptimismProxyBlockHistory is ProxyBlockHistory {
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

    function commitCurrentL1BlockHash() external {
        // https://community.optimism.io/docs/protocol/protocol-2.0/#l1block
        IL1Block l1Block = IL1Block(0x4200000000000000000000000000000000000015);
        _importTrustedHash(uint256(l1Block.number()), l1Block.hash());
    }
}
