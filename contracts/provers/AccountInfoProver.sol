/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "../interfaces/IReliquary.sol";
import "../RelicToken.sol";
import "../BlockHistory.sol";
import "./Prover.sol";
import "./StateVerifier.sol";
import "../lib/FactSigs.sol";

enum AccountInfo {
    StorageRoot,
    CodeHash,
    Balance,
    Nonce,
    RawHeader
}

/**
 * @title AccountInfoProver
 * @author Theori, Inc.
 * @notice AccountInfoProver proves info (nonce, balance, codehash) about an account at a particular block
 */
contract AccountInfoProver is Prover, StateVerifier {
    constructor(BlockHistory blockHistory, IReliquary _reliquary)
        Prover(_reliquary)
        StateVerifier(blockHistory, _reliquary)
    {}

    struct AccountInfoProof {
        address account;
        bytes accountProof;
        bytes header;
        bytes blockProof;
        AccountInfo info;
    }

    function parseAccountInfoProof(bytes calldata proof)
        internal
        pure
        returns (AccountInfoProof calldata res)
    {
        assembly {
            res := proof.offset
        }
    }

    /**
     * @notice Proves that an account contained particular info (nonce, balance, codehash) at a particular block.
     *
     * @param encodedProof the encoded AccountInfoProof
     */
    function _prove(bytes calldata encodedProof) internal view override returns (Fact memory) {
        AccountInfoProof calldata proof = parseAccountInfoProof(encodedProof);
        (
            bool exists,
            CoreTypes.BlockHeaderData memory head,
            CoreTypes.AccountData memory acc
        ) = verifyAccountAtBlock(proof.account, proof.accountProof, proof.header, proof.blockProof);
        require(exists, "Account does not exist at block");

        if (proof.info == AccountInfo.StorageRoot) {
            return
                Fact(
                    proof.account,
                    FactSigs.accountStorageFactSig(head.Number, acc.StorageRoot),
                    ""
                );
        } else if (proof.info == AccountInfo.CodeHash) {
            return
                Fact(proof.account, FactSigs.accountCodeHashFactSig(head.Number, acc.CodeHash), "");
        } else if (proof.info == AccountInfo.Balance) {
            return
                Fact(
                    proof.account,
                    FactSigs.accountBalanceFactSig(head.Number),
                    abi.encodePacked(acc.Balance)
                );
        } else if (proof.info == AccountInfo.Nonce) {
            return
                Fact(
                    proof.account,
                    FactSigs.accountNonceFactSig(head.Number),
                    abi.encodePacked(acc.Nonce)
                );
        } else if (proof.info == AccountInfo.RawHeader) {
            return Fact(proof.account, FactSigs.accountFactSig(head.Number), abi.encode(acc));
        } else {
            revert("Unknown account info requested");
        }
    }
}
