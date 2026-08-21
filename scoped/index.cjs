// see index.js => forward the unscoped `sql-switch` package wholesale (named exports & the
// default `createDAL` alike). CJS entry, so `require('@creative-softworks/sql-switch')` is
// byte for byte what `require('sql-switch')` returns.
module.exports = require('sql-switch');
