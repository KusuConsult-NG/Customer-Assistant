/**
 * The models that hang off a contact, for the merge script.
 *
 * Re-exported from `@ace/database` rather than defined twice: the API counts
 * these before deleting a citizen and the merge moves them before deleting a
 * duplicate, and the two must not disagree about what is attached to a person.
 */
const path = require('path');

function contactRelationModels() {
  const DB = path.join(__dirname, '..', '..', 'packages', 'database', 'dist', 'index.js');
  const { contactRelationModels: derive } = require(DB);
  return derive();
}

module.exports = { contactRelationModels };
