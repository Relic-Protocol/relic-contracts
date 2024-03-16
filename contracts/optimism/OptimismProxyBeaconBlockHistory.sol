/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity ^0.8.0;

import "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import "../ProxyBeaconBlockHistory.sol";

interface IL1Block {
    function hash() external view returns (bytes32);
    function number() external view returns (uint64);
}

/**
 * @title OptimismProxyBeaconBlockHistory
 * @author Theori, Inc.
 * @notice A wrapper around ProxyBeaconBlockHistory which translates the messenger address
 *         according to the Optimism aliasing rules and allows direct committing of
 *         the accessible L1 block data.
 */
contract OptimismProxyBeaconBlockHistory is ProxyBeaconBlockHistory {
    address public immutable messenger;

    constructor(
        address _messenger,
        address _reliquary,
        address _preDencunBlockHistory,
        uint256 _CAPELLA_SLOT,
        uint256 _DENCUN_SLOT,
        uint256 _UPGRADE_BLOCK
    )
        ProxyBeaconBlockHistory(
            _reliquary,
            _preDencunBlockHistory,
            _CAPELLA_SLOT,
            _DENCUN_SLOT,
            _UPGRADE_BLOCK
        )
    {
        messenger = AddressAliasHelper.applyL1ToL2Alias(_messenger);
    }

    /**
     * @notice Import a trusted block hash from the messenger
     * @param number the block number to import
     * @param hash the block hash
     */
    function importTrustedHash(uint256 number, bytes32 hash) external {
        require(msg.sender == messenger, "only the L1 messenger can import trusted block hashes");
        _storeCommittedBlock(number, hash);
    }

    function commitCurrentL1BlockHash() external {
        // https://community.optimism.io/docs/protocol/protocol-2.0/#l1block
        IL1Block l1Block = IL1Block(0x4200000000000000000000000000000000000015);
        _storeCommittedBlock(uint256(l1Block.number()), l1Block.hash());
    }
}
