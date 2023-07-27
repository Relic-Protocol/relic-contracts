/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "../interfaces/IReliquary.sol";
import "../lib/FactSigs.sol";
import "../RelicToken.sol";
import "./Prover.sol";
import "./StateVerifier.sol";

/**
 * @title TransactionProver
 * @author Theori, Inc.
 * @notice TransactionProver proves that a transaction hash occurred in a block.
 */
contract TransactionProver is Prover, StateVerifier {
    constructor(address blockHistory, IReliquary _reliquary)
        Prover(_reliquary)
        StateVerifier(blockHistory, _reliquary)
    {}

    struct TransactionProof {
        uint256 txIdx;
        bytes transactionProof;
        bytes header;
        bytes blockProof;
    }

    function parseTransactionProof(bytes calldata proof)
        internal
        pure
        returns (TransactionProof calldata res)
    {
        assembly {
            res := proof.offset
        }
    }

    /**
     * @notice Proves that a log occured in a block.
     *
     * @param encodedProof the encoded TransactionProof
     */
    function _prove(bytes calldata encodedProof) internal view override returns (Fact memory) {
        TransactionProof calldata proof = parseTransactionProof(encodedProof);
        (CoreTypes.BlockHeaderData memory head, bytes32 transaction) = verifyTransactionAtBlock(
            proof.txIdx,
            proof.transactionProof,
            proof.header,
            proof.blockProof
        );
        return
            Fact(
                address(0),
                FactSigs.transactionFactSig(transaction),
                abi.encode(head.Number, proof.txIdx)
            );
    }
}
