// Validates and replaces req.body / req.query / req.params using Zod schemas.
// Zod errors are turned into 400 responses by the error handler.
const validate = (schemas) => (req, _res, next) => {
  try {
    for (const key of ['params', 'query', 'body']) {
      if (schemas[key]) req[key] = schemas[key].parse(req[key] ?? {});
    }
    next();
  } catch (err) {
    next(err);
  }
};

export default validate;
