import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateDocumentDto, MAX_UPLOAD_BYTES } from '../documents/documents.dto';
import { isSupportedFile, SUPPORTED_EXTENSIONS } from '../ingestion/extractors';
import { JobsService, JobView } from './jobs.service';

/**
 * Asynchronous versions of the slow document operations: they answer 202 at once with a job to poll
 * at GET /jobs/:id. The plain /documents endpoints stay synchronous.
 */
@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get()
  list(@CurrentUser() owner: string): Promise<JobView[]> {
    return this.jobs.list(owner);
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() owner: string): Promise<JobView> {
    const job = await this.jobs.get(id, owner);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  /** Index pasted text in the background. */
  @Post('documents')
  @HttpCode(202)
  indexText(@Body() dto: CreateDocumentDto, @CurrentUser() owner: string): Promise<JobView> {
    return this.jobs.enqueue('ingest_text', { title: dto.title.trim(), payload: { ...dto }, owner });
  }

  /** Index an uploaded file in the background; text extraction happens in the job too. */
  @Post('upload')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@CurrentUser() owner: string, @UploadedFile() file?: Express.Multer.File): Promise<JobView> {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    if (!isSupportedFile(file.originalname)) {
      throw new BadRequestException(`Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
    }
    return this.jobs.enqueue('ingest_file', {
      title: file.originalname,
      payload: { filename: file.originalname },
      file: file.buffer,
      owner,
    });
  }

  /** Re-index every document in the background (e.g. after switching embedding model). */
  @Post('reindex')
  @HttpCode(202)
  reindexAll(@CurrentUser() owner: string): Promise<JobView> {
    return this.jobs.enqueue('reindex_all', { title: 'Re-index all documents', owner });
  }
}
