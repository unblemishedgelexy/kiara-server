const Joi = require('joi');

function validateRequest(schema) {
  return (req, res, next) => {
    const data = { body: req.body, query: req.query, params: req.params };
    const { error, value } = schema.validate(data, { abortEarly: false, allowUnknown: true });
    if (error) {
      const message = error.details.map((detail) => detail.message).join(', ');
      return res.status(400).json({ success: false, message });
    }
    req.validated = value;
    next();
  };
}

module.exports = validateRequest;
