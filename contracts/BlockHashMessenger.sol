/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "./lib/MerkleTree.sol";
import "./interfaces/IReliquary.sol";
import "./interfaces/IProxyBlockHistory.sol";

/**
 * @title BlockHashMessenger
 * @author Theori, Inc.
 * @notice Sends a block hash verified by the L1 BlockHistory and sends them to
 *         a ProxyBlockHistory. This contract is abstract so different message
 *         passing logic can be impelemented for each L2 / side chain.
 */
abstract contract BlockHashMessenger {
    IReliquary public immutable reliquary;
    address public immutable blockHistory;

    constructor(IReliquary _reliquary, address _blockHistory) {
        reliquary = _reliquary;
        blockHistory = _blockHistory;
    }

    function _sendMessage(
        address destination,
        bytes calldata params,
        bytes memory message
    ) internal virtual;

    function sendBlockHash(
        address destination,
        bytes calldata params,
        uint256 number,
        bytes32 blockHash,
        bytes calldata proof
    ) external payable {
        require(
            reliquary.validBlockHash(blockHistory, blockHash, number, proof),
            "Invalid block hash"
        );
        _sendMessage(
            destination,
            params,
            abi.encodeWithSelector(IProxyBlockHistory.importTrustedHash.selector, number, blockHash)
        );
    }
}
