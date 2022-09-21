/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "../RelicToken.sol";
import "../Reliquary.sol";

contract MockRelic is RelicToken {
    FactSignature immutable factSig;
    Reliquary immutable reliquary;

    constructor(
        uint8 factCls,
        bytes memory factDesc,
        Reliquary _reliquary
    ) RelicToken() {
        require(block.chainid == 31337, "testing only");
        factSig = Facts.toFactSignature(factCls, factDesc);
        reliquary = _reliquary;
    }

    function hasToken(address owner, uint96 data) internal view override returns (bool result) {
        require(data == 0);
        (result, , ) = reliquary.verifyFactNoFee(owner, factSig);
    }

    function name() external pure override returns (string memory) {
        return "Mock Relic";
    }

    function symbol() external pure override returns (string memory) {
        return "MOCK";
    }

    function tokenURI(
        uint256 /* tokenID */
    ) external pure override returns (string memory) {
        return "";
    }
}
