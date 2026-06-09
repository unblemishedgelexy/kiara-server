const express = require('express');
const { resetPassword } = require('../controllers/passwordController');

const router = express.Router();

router.post('/reset-password', resetPassword);

module.exports = router;
