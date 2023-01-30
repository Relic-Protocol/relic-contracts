/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "./Prover.sol";
import "../RelicToken.sol";
import "../interfaces/IReliquary.sol";

contract MockProver is Prover {
    FactSignature public immutable factSig;
    RelicToken immutable token;

    struct MockProof {
        address account;
        uint48 blockNum;
    }

    constructor(
        uint8 factCls,
        bytes memory factDesc,
        IReliquary _reliquary,
        RelicToken _token
    ) Prover(_reliquary) {
        require(block.chainid == 31337, "testing only");
        factSig = Facts.toFactSignature(factCls, factDesc);
        token = _token;
    }

    function parseMockProof(bytes calldata proof) internal pure returns (MockProof calldata res) {
        assembly {
            res := proof.offset
        }
    }

    function _prove(bytes calldata encodedProof) internal view override returns (Fact memory) {
        MockProof memory proof = parseMockProof(encodedProof);
        bytes memory data = abi.encodePacked(proof.blockNum);
        return Fact(proof.account, factSig, data);
    }

    function _afterStore(Fact memory fact, bool alreadyStored) internal override {
        if (!alreadyStored) {
            token.mint(fact.account, 0);
        }
    }
}
