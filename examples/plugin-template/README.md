# Hello Tool Plugin

This starter is deliberately small and requests no permissions. It exposes one structured tool capability named `hello`. `index.js` uses the Extension Runtime's CommonJS `module.exports.handlers` contract.

## Validate

From the CetaMesh repository root, run:

```powershell
npm run plugin:validate -- .\examples\plugin-template
```

## Run the fixture

```powershell
node .\examples\plugin-template\test.mjs
```

Copy the directory, choose your own namespaced plugin id and version, then add capabilities one at a time. Do not put credentials, private keys, `.env` files, `node_modules`, or `.git` into a package. Local plugins are marked **Unverified / Local**, require Developer Mode, pass Extension Runtime review, and install disabled.

The Extension Runtime process host isolates plugin execution in a child process and routes declared capabilities through CetaMesh. It is not an operating-system sandbox; never add native modules or shell execution.
