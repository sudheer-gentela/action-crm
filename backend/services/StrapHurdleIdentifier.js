/**
 * StrapHurdleIdentifier.js
 *
 * Registry pattern: dispatches to the correct entity-specific hurdle identifier.
 * Single entry point for StrapEngine — it calls identify(entityType, context)
 * and gets back the top hurdle.
 */

const DealHurdleIdentifier           = require('./DealHurdleIdentifier');
const AccountHurdleIdentifier        = require('./AccountHurdleIdentifier');
const ProspectHurdleIdentifier       = require('./ProspectHurdleIdentifier');
const ImplementationHurdleIdentifier = require('./ImplementationHurdleIdentifier');

const REGISTRY = {
  deal:           DealHurdleIdentifier,
  account:        AccountHurdleIdentifier,
  prospect:       ProspectHurdleIdentifier,
  implementation: ImplementationHurdleIdentifier,
};

class StrapHurdleIdentifier {

  /**
   * Identify the top hurdle for any entity type.
   *
   * @param {string} entityType  - 'deal' | 'account' | 'prospect' | 'implementation'
   * @param {object} context     - entity-specific context from StrapContextResolver
   * @returns {{ hurdleType: string, title: string, priority: string, evidence: string } | null}
   */
  static identify(entityType, context) {
    const identifier = REGISTRY[entityType];
    if (!identifier) {
      throw new Error(`StrapHurdleIdentifier: no identifier registered for entity_type "${entityType}"`);
    }
    return identifier.identify(context);
  }
}

module.exports = StrapHurdleIdentifier;
