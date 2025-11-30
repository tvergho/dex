# Dex Test Suite

This directory contains the test suite for Dex, using Bun's built-in test runner.

## Running Tests

```bash
# Run all tests (Bun + Cursor)
bun run test:all

# Run Bun tests only
bun test

# Run Cursor tests only (uses Node.js)
bun run test:cursor

# Run tests in watch mode
bun test --watch

# Run with coverage
bun test --coverage

# Run specific test file
bun test tests/unit/utils/export.test.ts

# Run tests matching a pattern
bun test --grep "generateFilename"
```

## Directory Structure

```
tests/
├── fixtures/           # Test data factories
│   └── index.ts        # Conversation, Message, File factories
├── helpers/            # Shared test utilities
│   ├── index.ts        # Re-exports all helpers
│   ├── db.ts           # TestDatabase class for isolated DB tests
│   ├── temp.ts         # Temporary directory management
│   ├── cli.ts          # Console/process mocking
│   ├── assertions.ts   # Custom file/directory assertions
│   └── time.ts         # Date/time utilities
├── unit/               # Unit tests (pure functions)
│   ├── utils/
│   │   ├── export.test.ts
│   │   ├── format.test.ts
│   │   ├── config.test.ts
│   │   └── platform.test.ts
│   ├── db/
│   │   ├── repository.test.ts
│   │   └── analytics.test.ts
│   ├── schema/
│   │   └── index.test.ts
│   └── adapters/
│       ├── claude-code.test.ts
│       ├── codex.test.ts
│       ├── opencode.test.ts
│       └── cursor.node-test.ts  # Runs with Node.js
├── integration/        # Integration tests (with I/O)
│   └── commands/
│       ├── export.test.ts
│       ├── backup.test.ts
│       ├── import.test.ts
│       ├── list.test.ts
│       ├── show.test.ts
│       ├── sync.test.ts
│       └── status.test.ts
└── README.md           # This file
```

## Writing Tests

### Unit Tests

Unit tests focus on pure functions with no side effects:

```typescript
import { describe, it, expect } from 'bun:test';
import { generateFilename } from '../../../src/utils/export';
import { createConversation } from '../../fixtures';

describe('generateFilename', () => {
  it('generates filename with date prefix', () => {
    const conv = createConversation({
      title: 'My Test',
      createdAt: '2025-01-15T10:00:00.000Z',
    });
    
    expect(generateFilename(conv)).toBe('2025-01-15_my-test.md');
  });
});
```

### Integration Tests

Integration tests use the test database and file system:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestDatabase } from '../../helpers/db';
import { TempDir } from '../../helpers/temp';
import { createConversation, createMessage } from '../../fixtures';

describe('export command', () => {
  let db: TestDatabase;
  let temp: TempDir;

  beforeEach(async () => {
    db = new TestDatabase();
    temp = new TempDir();
    await db.setup();
  });

  afterEach(async () => {
    await temp.cleanupAll();
    await db.teardown();
  });

  it('exports conversations', async () => {
    // Seed test data
    await db.seed({
      conversations: [createConversation()],
      messages: [createMessage('conv-id')],
    });
    
    const outputDir = await temp.create();
    
    // Run command
    const { exportCommand } = await import('../../../src/cli/commands/export');
    await exportCommand({ output: outputDir });
    
    // Assert
    // ...
  });
});
```

## Fixtures

Create test data with consistent defaults:

```typescript
import { createConversation, createMessage } from '../fixtures';

// With defaults
const conv = createConversation();

// With overrides
const customConv = createConversation({
  title: 'Custom Title',
  source: 'claude-code',
});

// Conversation with messages
const { conversation, messages } = createConversationWithMessages(5);
```

## Helpers

### TestDatabase

Isolated database for each test:

```typescript
const db = new TestDatabase();
await db.setup();          // Creates temp DB
await db.seed({ ... });    // Insert test data
await db.teardown();       // Cleanup
```

### TempDir

Temporary directory management:

```typescript
const temp = new TempDir();
const dir = await temp.create();                    // Create empty dir
const dir2 = await temp.createWithFiles({ ... });   // With files
await temp.cleanupAll();                            // Cleanup all
```

### CLI Mocking

Capture console output and process.exit:

```typescript
const mock = mockConsole();
// ... run code that logs ...
expect(mock.logs).toContain('Expected output');
mock.restore();

const exitMock = mockProcessExit();
// ... run code that exits ...
expect(exitMock.getExitCode()).toBe(1);
exitMock.restore();
```

### Assertions

Custom assertions for file operations:

```typescript
expectFileExists('/path/to/file');
await expectFileContains('/path/to/file', 'substring1', 'substring2');
await expectDirectoryStructure('/root', ['subdir/', 'file.txt']);
const count = await countFilesWithExtension('/dir', '.md');
```

## Best Practices

1. **Isolate tests** - Use `TestDatabase` and `TempDir` for clean state
2. **Use fixtures** - Create test data with factories, not raw objects
3. **Clean up** - Always call cleanup in `afterEach`
4. **Mock external calls** - Use CLI helpers to capture output
5. **Test edge cases** - Empty data, invalid inputs, boundary conditions

## Known Limitations

### Cursor Adapter Tests

The Cursor parser uses `better-sqlite3` which has compatibility issues with Bun's
test runner. To work around this, Cursor tests run separately using Node.js:

```bash
# Run Cursor tests specifically
bun run test:cursor

# Run all tests (Bun + Cursor)
bun run test:all
```

The Cursor tests exist in `cursor.node-test.ts` (note the hyphen) to prevent Bun
from attempting to run them. They run with Node's native test runner via tsx.


