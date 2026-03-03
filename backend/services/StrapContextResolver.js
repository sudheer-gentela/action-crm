/**
 * StrapContextResolver.js
 *
 * Dispatches to the correct context builder based on entity_type.
 * Single entry point for the StrapEngine — it never needs to know
 * which builder to call.
 *
 * Pattern: static class, matches DealContextBuilder / ProspectContextBuilder conventions.
 */

const DealContextBuilder     = require('./DealContextBuilder');
const AccountContextBuilder  = require('./AccountContextBuilder');
const ProspectContextBuilder = require('./ProspectContextBuilder');

class StrapContextResolver {

  /**
   * Build context for any entity type.
   *
   * @param {string} entityType  - 'deal' | 'account' | 'prospect' | 'implementation'
   * @param {number} entityId
   * @param {number} userId
   * @param {number} orgId
   * @returns {Promise<object>}  - entity-specific context object
   */
  static async resolve(entityType, entityId, userId, orgId) {
    switch (entityType) {
      case 'deal':
        return DealContextBuilder.build(entityId, userId, orgId);

      case 'account':
        return AccountContextBuilder.build(entityId, userId, orgId);

      case 'prospect':
        return ProspectContextBuilder.build(entityId, userId, orgId);

      case 'implementation':
        // Implementation STRAPs attach to closed_won deals.
        // Reuse DealContextBuilder — entityId IS the deal_id.
        return DealContextBuilder.build(entityId, userId, orgId);

      default:
        throw new Error(`StrapContextResolver: unknown entity_type "${entityType}"`);
    }
  }
}

module.exports = StrapContextResolver;
