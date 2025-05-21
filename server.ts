import { Elysia, t } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import puppeteer from 'puppeteer';
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
  async convertHtmlToPdf(html: string, options: any = {}) {
    logger.info('Starting HTML to PDF conversion');

    const browser = await puppeteer.launch({
      headless: true, // true로 설정
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
      const page = await browser.newPage();

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
      throw error;
    } finally {
      await browser.close();
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
        logger.info(`Converting URL to PDF: ${url}`);
        const browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        try {
          const page = await browser.newPage();
          await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: options.timeout || 30000
          });
          contentToRender = await page.content();
        } catch (error) {
          logger.error(error, `Failed to fetch URL: ${url}`);
          set.status = 400;
          return { error: `Failed to fetch URL: ${error.message}` };
        } finally {
          await browser.close();
        }
      } else if (html) {
        // HTML 콘텐츠가 제공된 경우
        logger.info('Converting HTML content to PDF');
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
      return { error: `Failed to convert to PDF: ${error.message}` };
    }
  }, {
    body: ConvertSchema.body,
    response: ConvertSchema.response,
    detail: {
      tags: ['pdf'],
      summary: 'Convert HTML or URL to PDF',
      description: 'Converts provided HTML content or web URL to a PDF document with extensive customization options'
    }
  })
  .listen(process.env.PORT || 3000);

logger.info(`Server is running at http://localhost:${app.server?.port}`);
logger.info(`API documentation available at http://localhost:${app.server?.port}/docs`);

export type App = typeof app;
