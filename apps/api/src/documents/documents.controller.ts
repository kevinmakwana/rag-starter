import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { extname } from 'path';
import { CreateDocumentDto, DocumentSummary, MAX_DOCUMENT_CHARS, titleFrom } from './documents.dto';
import { DocumentsService } from './documents.service';

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/** 201 for a new document, 200 when identical content already existed. */
function respondCreated(res: Response, doc: DocumentSummary): DocumentSummary {
  if (doc.duplicate) res.status(200);
  return doc;
}

@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Get()
  list(): Promise<DocumentSummary[]> {
    return this.documents.list();
  }

  /** Index pasted text. Responds 200 instead of 201 when the content was already indexed. */
  @Post()
  async create(
    @Body() dto: CreateDocumentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary> {
    return respondCreated(res, await this.documents.create(dto));
  }

  /** Index an uploaded .md or .txt file (multipart field name: "file"). */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async upload(
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<DocumentSummary> {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException('Only .md, .markdown and .txt files are supported');
    }
    const content = file.buffer.toString('utf8');
    if (content.length > MAX_DOCUMENT_CHARS) throw new BadRequestException('File is too large');
    const title = titleFrom(content, file.originalname.slice(0, -ext.length) || file.originalname);
    return respondCreated(res, await this.documents.create({ title, content, source: file.originalname }));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.documents.remove(id);
  }
}
