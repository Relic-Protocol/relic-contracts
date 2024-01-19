/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "../BlockHistory.sol";
import "../interfaces/IBatchProver.sol";
import "../interfaces/IReliquary.sol";
import "../lib/Storage.sol";
import "../lib/FactSigs.sol";
import "../lib/CoreTypes.sol";
import "./interfaces/IOptimismNativeBlockHistory.sol";

/**
 * @title OptimismNativeBlockHistory
 * @author Theori, Inc.
 * @notice OptimismNativeBlockHistory extends BlockHistory with the
 *         ability to trustlessly import a historical blockhash from
 *         an Optimism L2 output root stored on the L1. This is done
 *         using Relic's trustless access to L1 data. For more on how
 *         that works, see the ProxyBlockHistory contract.
 */
contract OptimismNativeBlockHistory is IOptimismNativeBlockHistory, BlockHistory {
    address public immutable override proxyMultiStorageSlotProver;
    address public immutable override l2OutputOracle;
    bytes32 public immutable override OUTPUT_ROOTS_BASE_SLOT;
    uint256 public immutable override FINALIZATION_PERIOD_SECONDS;

    /// @notice Hashes the various elements of an output root proof into an output root hash which
    ///         can be used to check if the proof is valid.
    /// @param _outputRootProof Output root proof which should hash to an output root.
    /// @return Hashed output root proof.
    function hashOutputRootProof(OutputRootProof calldata _outputRootProof) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _outputRootProof.version,
                _outputRootProof.stateRoot,
                _outputRootProof.messagePasserStorageRoot,
                _outputRootProof.latestBlockhash
            )
        );
    }

    constructor(
        uint256[] memory _sizes,
        IRecursiveVerifier[] memory _verifiers,
        address _reliquary,
        address _proxyMultiStorageSlotProver,
        address _l2OutputOracle,
        bytes32 _outputRootsBaseSlot,
        uint256 _finalizationPeriodSeconds
    ) BlockHistory(_sizes, _verifiers, _reliquary) {
        proxyMultiStorageSlotProver = _proxyMultiStorageSlotProver;
        l2OutputOracle = _l2OutputOracle;
        OUTPUT_ROOTS_BASE_SLOT = _outputRootsBaseSlot;
        FINALIZATION_PERIOD_SECONDS = _finalizationPeriodSeconds;
    }

    function importCheckpointBlockFromL1(
        bytes calldata proof,
        uint256 index,
        uint256 l1BlockNumber,
        OutputRootProof calldata outputRootProof
    ) external {
        require(index < 2 ** 64, "invalid output root index");

        Fact[] memory facts = IBatchProver(proxyMultiStorageSlotProver).proveBatch(proof, false);
        require(facts.length == 3, "invalid number of facts");

        require(
            FactSignature.unwrap(facts[0].sig) ==
            FactSignature.unwrap(FactSigs.blockHeaderSig(l1BlockNumber)),
            "first fact is not block header"
        );
        CoreTypes.BlockHeaderData memory l1Block = abi.decode(facts[0].data, (CoreTypes.BlockHeaderData));

        bytes32 slot = Storage.dynamicArrayElemSlot(OUTPUT_ROOTS_BASE_SLOT, index, 2);
        FactSignature expected = FactSigs.storageSlotFactSig(slot, l1BlockNumber);
        require(
            FactSignature.unwrap(facts[1].sig) == FactSignature.unwrap(expected),
            "first fact sig is incorrect"
        );
        expected = FactSigs.storageSlotFactSig(bytes32(uint256(slot) + 1), l1BlockNumber);
        require(
            FactSignature.unwrap(facts[2].sig) == FactSignature.unwrap(expected),
            "first fact sig is incorrect"
        );

        bytes32 outputRoot = bytes32(Storage.parseUint256(facts[1].data));
        require(outputRoot == hashOutputRootProof(outputRootProof), "outputRootProof is invalid");

        uint256 timestampAndBlockNum = Storage.parseUint256(facts[2].data);
        uint256 timestamp = uint256(uint128(timestampAndBlockNum));
        require(
            timestamp + FINALIZATION_PERIOD_SECONDS < l1Block.Time,
            "root not finalized at given L1 block"
        );

        uint256 blockNum = timestampAndBlockNum >> 128;
        _storeCommittedBlock(blockNum, outputRootProof.latestBlockhash);
    }
}
