import { describe, test, expect, beforeAll, afterAll, spyOn, mock } from 'bun:test'; // Changed it to test
import { app, pdfService } from '../server';

// Mock pino logger to suppress log output during tests
// Ensure this mock is compatible with how pino is initialized in server.ts
// If server.ts does `const logger = pino().child(...)`, this mock needs to support .child()
// If server.ts does `import pino from 'pino'; const logger = pino();`, this mock is fine.
mock.module('pino', () => {
  const pinoInstance = () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => pinoInstance(), // Ensure child loggers are also mocked
  });
  pinoInstance.default = pinoInstance; // if pino is imported as `import pino from 'pino'`
  return pinoInstance;
});


// Global setup for all tests in this file
beforeAll(async () => {
  // Stop the server if it was started by importing server.ts
  // This is tricky because server.ts calls startServer() automatically.
  // For testing, it's better if server.ts exports startServer but doesn't call it.
  // Assuming pdfService.init() can be called multiple times safely or is guarded.
  if (app && app.server && app.server.pendingRequests > 0) { // Check if server is running
      await app.stop(); // Attempt to stop the server if Elysia has this method and it's running
  }
  // Ensure pdfService's pool is initialized before tests run
  // The server.ts currently auto-starts, which calls pdfService.init().
  // If pdfService.init() is idempotent or guarded, calling it again is fine.
  // Otherwise, this might cause issues if the server is already running from import.
  // For robust testing, server.ts should not auto-start.
  // We will rely on the server.ts auto-start for now and assume init is safe.
  // await pdfService.init(); // Explicitly init if server didn't auto-start or if needed for clarity
});

afterAll(async () => {
  // Ensure pdfService's pool is closed after all tests
  await pdfService.closePool();
  // If app was started by tests or by import, try to stop it.
  if (app && app.server && app.server.pendingRequests > 0) { // Check if server is running
    // await app.stop(); // Ensure server is stopped
  }
});


describe('PdfService Direct Tests', () => {
  // These tests call pdfService methods directly.
  // Assumes pdfService.init() has been called by the global beforeAll or app auto-start.

  test('should convert simple HTML to PDF', async () => {
    const html = '<h1>Test PDF Service</h1><p>This is a test.</p>';
    const pdfBuffer = await pdfService.convertHtmlToPdf(html);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.byteLength).toBeGreaterThan(0); // Use byteLength for ArrayBuffer/Buffer
    // Verify it's a PDF by checking the magic number
    expect(Buffer.from(pdfBuffer).toString('utf-8', 0, 5)).toEqual('%PDF-');
  });

  test('should convert HTML to PDF with basic options', async () => {
    const html = '<h1>Test PDF Service with Options</h1>';
    const options = { format: 'A4', landscape: true };
    const pdfBuffer = await pdfService.convertHtmlToPdf(html, options);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(pdfBuffer).toString('utf-8', 0, 5)).toEqual('%PDF-');
  });

  test('should fetch HTML from a URL (example.com)', async () => {
    let htmlContent;
    try {
      htmlContent = await pdfService.fetchHtmlFromUrl('http://example.com');
    } catch (e: any) {
      // This test depends on network access to example.com
      // If it fails due to network issues, we log a warning and skip the assertion.
      if (e.message.includes('fetch') || e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED')) {
        console.warn(`Skipping fetchHtmlFromUrl direct test due to network issue: ${e.message}`);
        return; // Skip test assertions if network issue
      }
      throw e; // Re-throw other errors
    }
    expect(typeof htmlContent).toBe('string');
    expect(htmlContent.length).toBeGreaterThan(0);
    expect(htmlContent.toLowerCase()).toContain('<h1>example domain</h1>');
  });
});

describe('API /api/convert Endpoint Tests', () => {
  // These tests use app.handle() to simulate HTTP requests.
  // Assumes pdfService.init() has been called by the global beforeAll or app auto-start.

  test('POST with HTML should return PDF', async () => {
    const request = new Request('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>API Test HTML to PDF</h1>' })
    });
    const response = await app.handle(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toContain('filename="document.pdf"');
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(body).toString('utf-8', 0, 5)).toEqual('%PDF-');
  });

  test('POST with URL should return PDF', async () => {
    const request = new Request('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://example.com' })
    });

    let response;
    try {
      response = await app.handle(request);
    } catch (e: any) {
      if (e.message.includes('fetch') || e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED')) {
        console.warn(`Skipping API URL to PDF test due to network issue: ${e.message}`);
        return; 
      }
      throw e;
    }

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toContain('filename="document.pdf"');
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(body).toString('utf-8', 0, 5)).toEqual('%PDF-');
  });

  test('POST with HTML and custom filename should return PDF with correct Content-Disposition', async () => {
    const customFilename = "custom_report.pdf";
    const request = new Request('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: '<h1>Custom Filename Test</h1>',
        options: { filename: customFilename }
      })
    });
    const response = await app.handle(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${customFilename}"`);
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  test('POST with invalid body (empty JSON) should return 400', async () => {
    const request = new Request('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const response = await app.handle(request);
    expect(response.status).toBe(400);
    const jsonResponse = await response.json();
    expect(jsonResponse.error).toBe('Either HTML content or URL is required');
  });
  
  test('POST with invalid body (neither html nor url) should return 400', async () => {
    const request = new Request('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otherProperty: "some value" }) 
    });
    const response = await app.handle(request);
    expect(response.status).toBe(400);
    const jsonResponse = await response.json();
    expect(jsonResponse.error).toBe('Either HTML content or URL is required');
  });

  test('should return 500 if internal PDF conversion fails', async () => {
    // This test mocks convertHtmlToPdf to simulate an internal error.
    const originalMethod = pdfService.convertHtmlToPdf;
    pdfService.convertHtmlToPdf = mock(originalMethod).mockImplementation(async () => {
      throw new Error('Simulated internal PDF conversion error');
    });

    const request = new Request('http://localhost/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>Error Simulation</h1>' })
    });

    const response = await app.handle(request);
    expect(response.status).toBe(500);
    const jsonResponse = await response.json();
    expect(jsonResponse.error).toBe('Failed to convert to PDF: Simulated internal PDF conversion error');

    pdfService.convertHtmlToPdf = originalMethod; // Restore original method
  });

   test('should return 400 if URL fetching fails within the service', async () => {
    const originalMethod = pdfService.fetchHtmlFromUrl;
    pdfService.fetchHtmlFromUrl = mock(originalMethod).mockImplementation(async () => {
      throw new Error('Simulated internal URL fetch error');
    });
    
    const request = new Request('http://localhost/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://simulate.failure.com' })
    });

    const response = await app.handle(request);
    expect(response.status).toBe(400); // Should be 400 as per current error handling in API route for fetch errors
    const jsonResponse = await response.json();
    expect(jsonResponse.error).toBe('Failed to fetch URL: Simulated internal URL fetch error');

    pdfService.fetchHtmlFromUrl = originalMethod; // Restore original method
  });
});
