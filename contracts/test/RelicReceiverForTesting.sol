/// SPDX-License-Identifier: UNLICENSED
/// (c) Theori, Inc. 2022
/// All rights reserved
pragma solidity >=0.8.0;

import "../lib/CoreTypes.sol";
import "../lib/Facts.sol";
import "../lib/FactSigs.sol";
import "../interfaces/IRelicReceiver.sol";
import "../interfaces/IEphemeralFacts.sol";

/**
 * @title RelicReceiverForTesting
 * @author Theori, Inc.
 * @notice Simple implementation of IRelicReciever, expects extra data to be the fact
 *         signature data, and emits logs for each fact received.
 */
contract RelicReceiverForTesting is IRelicReceiver {
    IEphemeralFacts immutable ephemeralFacts;

    constructor(IEphemeralFacts _ephemeralFacts) {
        ephemeralFacts = _ephemeralFacts;
    }

    event FactReceived(address initiator, string name);

    /**
     * @notice receives an ephemeral fact from Relic
     * @param initiator the account which initiated the fact proving
     * @param fact the proven fact information
     * @param data extra data passed from the initiator - this data may come
     *        from untrusted parties and thus should be validated
     */
    function receiveFact(
        address initiator,
        Fact calldata fact,
        bytes calldata data
    ) external {
        require(msg.sender == address(ephemeralFacts), "only EphemeralFacts can call receiveFact");

        FactSignature computedSig = Facts.toFactSignature(Facts.NO_FEE, data);
        require(
            FactSignature.unwrap(fact.sig) == FactSignature.unwrap(computedSig),
            "extra data does not match fact signature"
        );

        string memory name = abi.decode(data, (string));
        emit FactReceived(initiator, name);
    }
}
