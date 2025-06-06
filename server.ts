import { Elysia, t } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import puppeteer, { Browser } from 'puppeteer-core'; // Assuming Browser type is needed
import * as genericPool from 'generic-pool';
import pino from 'pino';

// 로거 설정
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined
});

// PDF 서비스
class PdfService {
  private pool: genericPool.Pool<Browser> | null = null;

  async init() {
    if (this.pool) {
      logger.info('Puppeteer browser pool already initialized.');
      return;
    }
    logger.info('Initializing Puppeteer browser pool with puppeteer-core...');

    // Factory for creating and destroying browser instances for the pool
    const puppeteerFactory: genericPool.Factory<Browser> = {
      create: async (): Promise<Browser> => {
        // Determine the executable path for Chromium
        const executablePathEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
        let finalExecutablePath: string | undefined = undefined;
        if (executablePathEnv) {
          finalExecutablePath = executablePathEnv;
        } else {
          finalExecutablePath = '/usr/bin/chromium-browser'; // Default fallback for Linux environments
          logger.warn(`Pool: PUPPETEER_EXECUTABLE_PATH environment variable not set. Falling back to default: ${finalExecutablePath}. This should be configured in production if not using the official Docker image.`);
        }

        // Determine Puppeteer launch arguments
        const defaultArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
        const envArgs = process.env.PUPPETEER_LAUNCH_ARGS;
        let launchArgs = defaultArgs;
        if (envArgs) {
          launchArgs = envArgs.split(',').map(arg => arg.trim());
        }
        logger.info(`Pool: Creating new browser instance. Executable: ${finalExecutablePath}, Args: ${launchArgs.join(' ')}`);
        
        // Launch and return a new browser instance
        try {
          const browser = await puppeteer.launch({
            executablePath: finalExecutablePath,
            headless: true, // Always run headless in server environments
            args: launchArgs,
          });
          return browser;
        } catch (error) {
          logger.error(error, `Pool: Failed to create puppeteer instance with executable path '${finalExecutablePath}' and args: ${launchArgs.join(' ')}`);
          throw error; // Propagate error to prevent pool from potentially using a bad factory
        }
      },
      // Method to destroy a browser instance when it's removed from the pool
      destroy: async (browser: Browser): Promise<void> => {
        logger.info('Pool: Destroying browser instance.');
        await browser.close();
      },
      // Optional: validate method could be added here to check browser health before use
      // validate: async (browser: Browser): Promise<boolean> => { ... }
    };

    // Configuration options for the generic-pool
    const poolOptions: genericPool.Options = {
      min: parseInt(process.env.PUPPETEER_POOL_MIN || "2"), // Minimum number of browser instances in the pool
      max: parseInt(process.env.PUPPETEER_POOL_MAX || "5"), // Maximum number of browser instances in the pool
      acquireTimeoutMillis: parseInt(process.env.PUPPETEER_POOL_ACQUIRE_TIMEOUT_MS || "30000"), // Max time (ms) to wait for a resource from the pool
      maxWaitingClients: parseInt(process.env.PUPPETEER_POOL_MAX_WAITING_CLIENTS || "10"), // Max number of clients waiting for a resource if the pool is exhausted
      // testOnBorrow: true, // Could be enabled if a 'validate' method is implemented in the factory
    };
    logger.info(`Initializing browser pool with options: Min=${poolOptions.min}, Max=${poolOptions.max}, AcquireTimeout=${poolOptions.acquireTimeoutMillis}ms, MaxWaitingClients=${poolOptions.maxWaitingClients}`);

    try {
      // Create the browser pool
      this.pool = genericPool.createPool<Browser>(puppeteerFactory, poolOptions);
      logger.info('Puppeteer browser pool initialized successfully.');
    } catch (error) {
      logger.error(error, 'Failed to create Puppeteer browser pool.');
      throw error; // Re-throw to prevent server from starting if pool initialization fails
    }
  }

  async closePool() {
    if (this.pool) {
      logger.info('Closing Puppeteer browser pool...');
      try {
        // Drain the pool, destroying all resources
        await this.pool.drain();
        // Clear any remaining resources (should be empty after drain)
        await this.pool.clear();
        this.pool = null;
        logger.info('Puppeteer browser pool closed successfully.');
      } catch (error) {
        logger.error(error, 'Error closing Puppeteer browser pool.');
      }
    } else {
      logger.info('Puppeteer browser pool is not initialized or already closed.');
    }
  }

  async fetchHtmlFromUrl(url: string, options: any = {}) {
    if (!this.pool) {
      throw new Error('Browser pool not initialized. Call init() first.');
    }
    // Acquire a browser instance from the pool
    logger.info(`Acquiring browser from pool for URL: ${url}`);
    const browser = await this.pool.acquire();
    // Log current pool status for monitoring
    logger.info(`Browser acquired for URL: ${url}. Pool status: size=${this.pool.size}, available=${this.pool.available}, pending=${this.pool.pending}`);
    
    const page = await browser.newPage();
    try {
      await page.goto(url, {
        waitUntil: 'networkidle0', // Wait until network activity has ceased
        timeout: options.timeout || 30000 // Configurable page load timeout
      });
      return await page.content();
    } catch (error) {
      logger.error(error, `Failed to fetch URL: ${url}`);
      throw error; // Re-throw the error to be handled by the caller
    } finally {
      await page.close(); // Ensure the page is closed
      logger.info(`Page closed for URL: ${url}`);
      // Release the browser instance back to the pool
      if (browser) {
        await this.pool.release(browser);
        logger.info(`Browser instance released back to the pool. Pool status: size=${this.pool.size}, available=${this.pool.available}, pending=${this.pool.pending}`);
      }
    }
  }

  async convertHtmlToPdf(html: string, options: any = {}) {
    if (!this.pool) {
      throw new Error('Browser pool not initialized. Call init() first.');
    }
    // Acquire a browser instance from the pool
    logger.info('Acquiring browser from pool for HTML to PDF conversion.');
    const browser = await this.pool.acquire();
    // Log current pool status for monitoring
    logger.info(`Browser acquired for HTML to PDF. Pool status: size=${this.pool.size}, available=${this.pool.available}, pending=${this.pool.pending}`);
    
    const page = await browser.newPage();
    try {
      // 뷰포트 크기 설정
      await page.setViewport({
        width: options.width || 1200,
        height: options.height || 1600,
        deviceScaleFactor: options.scale || 1
      });

      // HTML 콘텐츠 설정
      await page.setContent(html, {
        waitUntil: 'networkidle0',
        timeout: options.timeout || 30000
      });

      // 사용자 지정 CSS 적용
      if (options.css) {
        await page.addStyleTag({ content: options.css });
      }

      // 페이지 로딩 대기 선택사항 - options에 명시적으로 설정된 경우에만 실행
      if (options.waitForSelector) {
        try {
          logger.info(`Waiting for selector: ${options.waitForSelector}`);
          await page.waitForSelector(options.waitForSelector, {
            timeout: options.selectorTimeout || 5000 // 선택자 대기 시간을 별도로 설정
          });
        } catch (error) {
          // 선택자를 찾지 못한 경우 경고만 출력하고 계속 진행
          logger.warn(`Selector "${options.waitForSelector}" not found: ${error.message}. Continuing with PDF generation.`);
        }
      }

      // 초기 지연 시간 (JS가 로드되고 실행되는 것을 기다림)
      if (options.delay && options.delay > 0) {
        logger.info(`Delaying PDF generation for ${options.delay}ms`);
        await new Promise(resolve => setTimeout(resolve, options.delay));
      }

      // PDF 생성
      logger.info('Generating PDF');
      const pdfBuffer = await page.pdf({
        format: options.format || 'A4',
        printBackground: options.printBackground !== false,
        margin: options.margin || {
          top: '1cm',
          right: '1cm',
          bottom: '1cm',
          left: '1cm'
        },
        landscape: options.landscape || false,
        headerTemplate: options.headerTemplate || '',
        footerTemplate: options.footerTemplate || '',
        displayHeaderFooter: !!options.headerTemplate || !!options.footerTemplate,
        pageRanges: options.pageRanges || '',
        scale: options.pdfScale || 1,
        preferCSSPageSize: options.preferCSSPageSize || false
      });

      logger.info('PDF generation completed successfully');
      return pdfBuffer;
    } catch (error) {
      logger.error(error, 'Error in PDF conversion');
      throw error; // Re-throw the error to be handled by the caller
    } finally {
      await page.close(); // Ensure the page is closed
      logger.info('Page closed after PDF conversion.');
      // Release the browser instance back to the pool
      if (browser) {
        await this.pool.release(browser);
        logger.info(`Browser instance released back to the pool. Pool status: size=${this.pool.size}, available=${this.pool.available}, pending=${this.pool.pending}`);
      }
    }
  }
}

const pdfService = new PdfService();

// 스키마 정의
const MarginSchema = t.Object({
  top: t.Optional(t.String({ default: '1cm', examples: ['1cm', '10mm', '0.5in'] })),
  right: t.Optional(t.String({ default: '1cm', examples: ['1cm', '10mm', '0.5in'] })),
  bottom: t.Optional(t.String({ default: '1cm', examples: ['1cm', '10mm', '0.5in'] })),
  left: t.Optional(t.String({ default: '1cm', examples: ['1cm', '10mm', '0.5in'] }))
});

// 공통 옵션 스키마
const OptionsSchema = t.Object({
  // 문서 형식 관련 옵션
  format: t.Optional(t.String({
    description: 'PDF page format',
    default: 'A4',
    examples: ['A4', 'Letter', 'Legal', 'Tabloid']
  })),
  width: t.Optional(t.Number({
    description: 'Page width in pixels (for viewport)',
    default: 1200,
    examples: [1200]
  })),
  height: t.Optional(t.Number({
    description: 'Page height in pixels (for viewport)',
    default: 1600,
    examples: [1600]
  })),
  scale: t.Optional(t.Number({
    description: 'Device scale factor',
    default: 1,
    examples: [1]
  })),
  pdfScale: t.Optional(t.Number({
    description: 'Scale of the webpage rendering',
    default: 1,
    examples: [0.8, 1, 1.2]
  })),

  // 레이아웃 관련 옵션
  landscape: t.Optional(t.Boolean({
    description: 'Page orientation',
    default: false
  })),
  margin: t.Optional(MarginSchema),
  printBackground: t.Optional(t.Boolean({
    description: 'Print background graphics',
    default: true
  })),

  // 스타일 관련 옵션
  css: t.Optional(t.String({
    description: 'Custom CSS to inject into the page',
    examples: ['body { font-family: Arial; } .page-break { page-break-after: always; }']
  })),
  preferCSSPageSize: t.Optional(t.Boolean({
    description: 'Prefer page size defined in CSS',
    default: false
  })),

  // 헤더/푸터 관련 옵션
  headerTemplate: t.Optional(t.String({
    description: 'HTML template for the print header',
    examples: ['<div style="font-size: 10px; text-align: center; width: 100%;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>']
  })),
  footerTemplate: t.Optional(t.String({
    description: 'HTML template for the print footer',
    examples: ['<div style="font-size: 10px; text-align: center; width: 100%;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>']
  })),

  // 고급 렌더링 옵션
  delay: t.Optional(t.Number({
    description: 'Delay in milliseconds to wait after page load',
    default: 0,
    examples: [500]
  })),
  waitForSelector: t.Optional(t.String({
    description: 'Wait for the specified CSS selector to appear in page (use with caution)',
    examples: ['#content-loaded']
  })),
  selectorTimeout: t.Optional(t.Number({
    description: 'Maximum time to wait for selector in milliseconds',
    default: 5000,
    examples: [5000]
  })),
  timeout: t.Optional(t.Number({
    description: 'Maximum page load time in milliseconds',
    default: 30000,
    examples: [30000]
  })),
  pageRanges: t.Optional(t.String({
    description: 'Page ranges to print, e.g., "1-5, 8, 11-13"',
    examples: ['1-5']
  })),

  // 메타데이터 관련 옵션
  filename: t.Optional(t.String({
    description: 'Suggested filename for the PDF',
    default: 'document.pdf',
    examples: ['report.pdf', 'invoice.pdf']
  }))
});

const ConvertSchema = {
  body: t.Union([
    // HTML 콘텐츠를 사용하는 경우
    t.Object({
      html: t.String({
        description: 'HTML content to convert to PDF',
        examples: ['<h1>Hello, World!</h1><p>This is a PDF generated from HTML.</p>']
      }),
      options: t.Optional(OptionsSchema)
    }),

    // URL을 사용하는 경우
    t.Object({
      url: t.String({
        description: 'URL to convert to PDF',
        examples: ['https://example.com']
      }),
      options: t.Optional(OptionsSchema)
    })
  ]),
  response: {
    200: t.Unknown({ description: 'PDF file as binary data' }),
    400: t.Object({
      error: t.String({ description: 'Error message' })
    }),
    500: t.Object({
      error: t.String({ description: 'Error message' })
    })
  }
};

// 서버 설정
const app = new Elysia()
  .use(swagger({
    documentation: {
      info: {
        title: 'PDF Generation API',
        version: '1.0.0',
        description: `
# HTML-to-PDF Conversion API

This API allows you to convert HTML content or web URLs to high-quality PDF documents with extensive customization options.

## Key Features

- Convert HTML content or URLs to PDF
- Customize page size, margins, and orientation
- Add headers and footers with page numbers
- Apply custom CSS styles
- Control page breaks and layout
- Adjust rendering delays for JavaScript-heavy pages
- Specify custom filename for the generated PDF

## Optimizations & Concurrency

This service utilizes \`puppeteer-core\` for PDF generation, with the Chromium browser conveniently bundled within its official Docker image. To efficiently handle multiple requests, it implements a pool of browser instances. The behavior of this pool and Puppeteer can be tuned using the following environment variables:

*   \`PUPPETEER_POOL_MIN\`: Minimum number of browser instances to keep in the pool (Default: 2).
*   \`PUPPETEER_POOL_MAX\`: Maximum number of browser instances the pool can create (Default: 5).
*   \`PUPPETEER_POOL_ACQUIRE_TIMEOUT_MS\`: Maximum time (in milliseconds) a request will wait for an available browser instance from the pool (Default: 30000).
*   \`PUPPETEER_POOL_MAX_WAITING_CLIENTS\`: Maximum number of requests that can be queued waiting for a browser instance if the pool is at its maximum capacity (Default: 10).
*   \`PUPPETEER_LAUNCH_ARGS\`: Custom comma-separated arguments for launching browser instances (e.g., "--disable-gpu,--no-zygote").
*   \`PUPPETEER_EXECUTABLE_PATH\`: (Informational) Set automatically within the Docker image to the path of the bundled Chromium.
*   \`LOG_LEVEL\`: Sets the application log level (e.g., 'info', 'debug', 'warn', 'error'. Default: 'info').
*   \`PORT\`: Port the server listens on (Default: 3000).

These configurations allow for fine-tuning the performance and resource usage of the service based on your deployment environment and expected load.

## Example Use Cases

- Generate invoices, receipts and financial documents
- Create reports with consistent branding and layout
- Convert web articles to PDF for offline reading
- Produce certificates and official documents
- Create printable versions of web content
        `
      },
      tags: [
        { name: 'pdf', description: 'PDF generation endpoints' }
      ]
    },
    path: '/docs'
  }))
  .get('/', () => 'HTML to PDF Conversion Service - Go to /docs for API documentation')
  .post('/api/convert', async ({ body, set }) => {
    try {
      // body의 타입에 따라 html 또는 url 속성을 가져옴
      const { html, url, options = {} } = body as {
        html?: string;
        url?: string;
        options?: any;
      };

      let contentToRender: string;

      // URL이 제공된 경우 해당 페이지의 HTML 가져오기
      if (url) {
        logger.info(`Fetching content from URL for PDF conversion: ${url}`);
        try {
          contentToRender = await pdfService.fetchHtmlFromUrl(url, options);
        } catch (error) {
          logger.error(error, `Failed to fetch URL: ${url}`);
          set.status = 400;
          // Ensure error is an instance of Error for message property
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { error: `Failed to fetch URL: ${errorMessage}` };
        }
      } else if (html) {
        // HTML 콘텐츠가 제공된 경우
        logger.info('Using provided HTML content for PDF conversion');
        contentToRender = html;
      } else {
        // 둘 다 제공되지 않은 경우 (원래 스키마에 의해 이미 방지되지만, 타입 안전성을 위해 추가)
        set.status = 400;
        return { error: 'Either HTML content or URL is required' };
      }

      const pdfBuffer = await pdfService.convertHtmlToPdf(contentToRender, options);

      // 파일명 설정 (options에서 가져오거나 기본값 사용)
      const filename = options.filename || 'document.pdf';

      set.headers['Content-Type'] = 'application/pdf';
      set.headers['Content-Disposition'] = `attachment; filename="${filename}"`;

      return pdfBuffer;
    } catch (error) {
      logger.error(error, 'Failed to convert to PDF');
      set.status = 500;
      // Ensure error is an instance of Error for message property
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: `Failed to convert to PDF: ${errorMessage}` };
    }
  }, {
    body: ConvertSchema.body,
    response: ConvertSchema.response,
    detail: {
      tags: ['pdf'],
      summary: 'Convert HTML or URL to PDF',
      description: 'Converts provided HTML content or web URL to a PDF document with extensive customization options'
    }
  });

// Initialize PDF service and start server
const startServer = async () => {
  try {
    await pdfService.init(); // Initialize browser instance
    await app.listen(process.env.PORT || 3000);
    logger.info(`Server is running at http://localhost:${app.server?.port}`);
    logger.info(`API documentation available at http://localhost:${app.server?.port}/docs`);
  } catch (error) {
    logger.error(error, 'Failed to start server or initialize PDF service');
    process.exit(1);
  }
};

startServer();

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'] as const;
signals.forEach(signal => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down...`);
    try {
      await pdfService.closePool(); // Changed from closeBrowser to closePool
      if (app && app.server) {
        await app.stop(); // Stop Elysia server if possible (Elysia's stop method might vary)
      }
      logger.info('Server shut down gracefully.');
      process.exit(0);
    } catch (error) {
      logger.error(error, 'Error during graceful shutdown');
      process.exit(1);
    }
  });
});

export type App = typeof app;
export { app, pdfService };
