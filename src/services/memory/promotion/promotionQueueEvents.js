'use strict';

const { EventEmitter } = require('node:events');

const promotionQueueEvents = new EventEmitter();

module.exports = promotionQueueEvents;
