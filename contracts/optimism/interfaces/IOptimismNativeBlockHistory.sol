/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "../../interfaces/IBlockHistory.sol";

/**
 * @title Optimism native block history provider
 * @author Theori, Inc.
 */

interface IOptimismNativeBlockHistory is IBlockHistory {
    // https://github.com/ethereum-optimism/optimism/blob/65ec61dde94ffa93342728d324fecf474d228e1f/packages/contracts-bedrock/contracts/libraries/Types.sol#L33
    /**
     * @notice Struct representing the elements that are hashed together to generate an output root
     *         which itself represents a snapshot of the L2 state.
     *
     * @custom:field version                  Version of the output root.
     * @custom:field stateRoot                Root of the state trie at the block of this output.
     * @custom:field messagePasserStorageRoot Root of the message passer storage trie.
     * @custom:field latestBlockhash          Hash of the block this output was generated from.
     */
    struct OutputRootProof {
        bytes32 version;
        bytes32 stateRoot;
        bytes32 messagePasserStorageRoot;
        bytes32 latestBlockhash;
    }

    function proxyMultiStorageSlotProver() external view returns (address);
    function l2OutputOracle() external view returns (address);
    function OUTPUT_ROOTS_BASE_SLOT() external view returns (bytes32);
    function FINALIZATION_PERIOD_SECONDS() external view returns (uint256);

    function importCheckpointBlockFromL1(
        bytes calldata proof,
        uint256 index,
        uint256 l1BlockNumber,
        OutputRootProof calldata outputRootProof
    ) external;
}
