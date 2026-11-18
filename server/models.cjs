const path = require('node:path');
const root = path.join(__dirname, '..', 'variant-b');
const M = require(path.join(root, 'model.js'));
const Access = require(path.join(root, 'assets', 'access-model.js'));
const Leads = require(path.join(root, 'leads-model.js'));
const Communications = require(path.join(root, 'assets', 'communications-model.js'));
const Inbox = require(path.join(root, 'assets', 'inbox-model.js'));
const Delivery = require(path.join(root, 'delivery-model.js'));

module.exports = {M, Access, Leads, Communications, Inbox, Delivery};
