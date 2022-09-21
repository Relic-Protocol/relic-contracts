/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.12;

import "@openzeppelin/contracts/utils/Base64.sol";

import "../interfaces/ITokenURI.sol";

contract MockTokenURI is ITokenURI {
    constructor() {
        require(block.chainid == 31337, "testing only");
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(
                        bytes(
                            abi.encodePacked(
                                '{"name":"',
                                "MockEvent",
                                '", "description":"',
                                "token description for testing",
                                '", "image": "data:image/svg+xml;base64,',
                                Base64.encode(
                                    bytes(
                                        abi.encodePacked(
                                            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"></svg>'
                                        )
                                    )
                                ),
                                '"}'
                            )
                        )
                    )
                )
            );
    }
}
