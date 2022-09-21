/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "../interfaces/IFeeDelegate.sol";

contract MockFeeDelegate is IFeeDelegate {
    function checkFee(
        address, /* sender */
        bytes calldata /* data */
    ) external payable {
        require(msg.value == 1 ether);
    }
}
