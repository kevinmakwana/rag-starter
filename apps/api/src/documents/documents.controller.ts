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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { extname } from 'path';
import { CreateDocumentDto, DocumentSummary, MAX_DOCUMENT_CHARS, titleFrom } from './documents.dto';
import { DocumentsService } from './documents.service';

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Get()
  list(): Promise<DocumentSummary[]> {
    return this.documents.list();
  }

  /** Index pasted text. */
  @Post()
  create(@Body() dto: CreateDocumentDto): Promise<DocumentSummary> {
    return this.documents.create(dto);
  }

  /** Index an uploaded .md or .txt file (multipart field name: "file"). */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  upload(@UploadedFile() file?: Express.Multer.File): Promise<DocumentSummary> {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException('Only .md, .markdown and .txt files are supported');
    }
    const content = file.buffer.toString('utf8');
    if (content.length > MAX_DOCUMENT_CHARS) throw new BadRequestException('File is too large');
    const title = titleFrom(content, file.originalname.slice(0, -ext.length) || file.originalname);
    return this.documents.create({ title, content, source: file.originalname });
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.documents.remove(id);
  }
}
