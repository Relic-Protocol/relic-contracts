/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved

pragma solidity >=0.8.0;

import "../lib/AuxMerkleTree.sol";

/**
 * @title AuxRootTest
 * @author Theori, Inc.
 * @notice Test contract for Auxiliary Merkle Roots
 */
contract AuxRootTest {
    function auxRoot(bytes32[] calldata inputs) external view returns (bytes32 result) {
        result = AuxMerkleTree.computeRoot(inputs);
    }
}
