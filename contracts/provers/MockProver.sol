/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "../RelicToken.sol";
import "../interfaces/IReliquary.sol";

contract MockProver {
    FactSignature public immutable factSig;
    IReliquary immutable reliquary;
    RelicToken immutable token;

    constructor(
        uint8 factCls,
        bytes memory factDesc,
        IReliquary _reliquary,
        RelicToken _token
    ) {
        require(block.chainid == 31337, "testing only");
        factSig = Facts.toFactSignature(factCls, factDesc);
        reliquary = _reliquary;
        token = _token;
    }

    function proveFact(address account, uint48 blockNum) external payable {
        reliquary.checkProveFactFee{value: msg.value}(msg.sender);

        reliquary.setFact(account, factSig, abi.encodePacked(blockNum));
    }

    function proveFactWithNFT(address account, uint48 blockNum) external payable {
        reliquary.checkProveFactFee{value: msg.value}(msg.sender);

        (bool proven, , ) = reliquary.getFact(account, factSig);
        reliquary.setFact(account, factSig, abi.encodePacked(blockNum));
        if (!proven) {
            token.mint(account, 0);
        }
    }
}
