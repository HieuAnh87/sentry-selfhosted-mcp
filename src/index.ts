#!/usr/bin/env node
// Entry point - re-export from server for backward compatibility
// The shebang is required: package.json maps `bin` here and the build chmods 755,
// so without it the shell executes the file instead of node.
import './server.js';
