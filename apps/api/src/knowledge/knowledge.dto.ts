import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UploadDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  /**
   * Advisory only — the server recomputes the real size from the decoded buffer.
   * A client-declared size cannot be allowed to gate a size limit.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  mimeType!: string;

  @IsString()
  @MinLength(1)
  fileBufferBase64!: string;
}

export class CrawlWebsiteDto {
  @IsString()
  @MinLength(4)
  @MaxLength(2048)
  url!: string;

  /**
   * How many pages to index, starting from this URL. 1 (the default) is the
   * single page, which is what every existing caller expects. Above 1 the
   * crawler walks the site — sitemap first, then same-origin links — which is
   * how a public site gets indexed without somebody guessing its paths by
   * hand. Capped server-side.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  maxPages?: number;
}

export class KnowledgeMetadataDto {
  @IsOptional() @IsString() @MaxLength(1000) sourceUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) mdaOwner?: string;
  @IsOptional() @IsString() publishedAt?: string;
  @IsOptional() @IsString() effectiveDate?: string;
  @IsOptional() @IsString() reviewDueAt?: string;
}

export class WithdrawKnowledgeDto {
  @IsString() @MaxLength(1000) reason!: string;
}

export class UpdateGapDto {
  @IsOptional() @IsIn(['OPEN', 'ASSIGNED', 'RESOLVED', 'DISMISSED']) status?: string;
  @IsOptional() @IsString() @MaxLength(4000) resolution?: string;
  @IsOptional() @IsString() assignedUserId?: string | null;
}
