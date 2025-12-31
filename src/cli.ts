#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { initMcpServerWithTransport } from './mcp-server/shared/init.js';
import { logger } from './mcp-server/shared/logger.js';
import { logger as utilsLogger } from './utils/logger.js';
import { McpServerOptions } from './mcp-server/shared/types.js';
import { AuthManager } from './auth/auth-manager.js';
import { WechatApiClient } from './wechat/api-client.js';
import FormData from 'form-data';
import path from 'path';

// CLI 模式下禁用日志输出到 stdout
utilsLogger.setSilent(true);

const program = new Command();

// 统一 JSON 输出格式
interface CliResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function output(result: CliResult): void {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

function success(data: Record<string, unknown>): void {
  output({ ok: true, data });
}

function error(code: string, message: string): void {
  output({ ok: false, error: { code, message } });
}

// 从环境变量读取凭据
function getEnvCredentials(): { appId?: string; appSecret?: string } {
  return {
    appId: process.env.WECHAT_APP_ID,
    appSecret: process.env.WECHAT_APP_SECRET,
  };
}

// 初始化 API 客户端（优先使用环境变量）
async function initApiClient(): Promise<WechatApiClient> {
  const authManager = new AuthManager();
  await authManager.initialize();

  // 如果环境变量有凭据，自动配置
  const envCreds = getEnvCredentials();
  if (envCreds.appId && envCreds.appSecret) {
    const currentConfig = await authManager.getConfig();
    // 只有当环境变量与已存储配置不同时才更新
    if (!currentConfig || currentConfig.appId !== envCreds.appId) {
      await authManager.setConfig({
        appId: envCreds.appId,
        appSecret: envCreds.appSecret,
      });
    }
  }

  return new WechatApiClient(authManager);
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

program
  .name('wechat-cli')
  .description('WeChat Official Account CLI Tool')
  .version(getVersion());

// ============ AUTH 命令 ============
const authCmd = program.command('auth').description('认证管理');

authCmd
  .command('configure')
  .description('配置微信公众号凭据（也可通过环境变量 WECHAT_APP_ID/WECHAT_APP_SECRET 设置）')
  .option('--app-id <appId>', '微信公众号 AppID（或使用 WECHAT_APP_ID 环境变量）')
  .option('--secret <appSecret>', '微信公众号 AppSecret（或使用 WECHAT_APP_SECRET 环境变量）')
  .option('--token <token>', '微信公众号 Token（可选）')
  .option('--aes-key <encodingAESKey>', '微信公众号 EncodingAESKey（可选）')
  .action(async (options) => {
    try {
      const envCreds = getEnvCredentials();
      const appId = options.appId || envCreds.appId;
      const appSecret = options.secret || envCreds.appSecret;

      if (!appId || !appSecret) {
        error('MISSING_CREDENTIALS', '需要提供 --app-id 和 --secret，或设置 WECHAT_APP_ID/WECHAT_APP_SECRET 环境变量');
        return;
      }

      const authManager = new AuthManager();
      await authManager.initialize();
      await authManager.setConfig({
        appId,
        appSecret,
        token: options.token,
        encodingAESKey: options.aesKey,
      });
      success({
        appId: options.appId,
        configured: true,
        message: '微信公众号配置已保存',
      });
    } catch (e) {
      error('AUTH_CONFIG_FAILED', (e as Error).message);
    }
  });

authCmd
  .command('get-token')
  .description('获取当前 Access Token')
  .action(async () => {
    try {
      const authManager = new AuthManager();
      await authManager.initialize();
      const tokenInfo = await authManager.getAccessToken();
      const expiresIn = Math.max(0, Math.floor((tokenInfo.expiresAt - Date.now()) / 1000));
      success({
        accessToken: tokenInfo.accessToken,
        expiresIn,
        expiresAt: new Date(tokenInfo.expiresAt).toISOString(),
      });
    } catch (e) {
      error('GET_TOKEN_FAILED', (e as Error).message);
    }
  });

authCmd
  .command('refresh-token')
  .description('刷新 Access Token')
  .action(async () => {
    try {
      const authManager = new AuthManager();
      await authManager.initialize();
      const tokenInfo = await authManager.refreshAccessToken();
      const expiresIn = Math.max(0, Math.floor((tokenInfo.expiresAt - Date.now()) / 1000));
      success({
        accessToken: tokenInfo.accessToken,
        expiresIn,
        expiresAt: new Date(tokenInfo.expiresAt).toISOString(),
      });
    } catch (e) {
      error('REFRESH_TOKEN_FAILED', (e as Error).message);
    }
  });

authCmd
  .command('get-config')
  .description('获取当前配置')
  .action(async () => {
    try {
      const authManager = new AuthManager();
      await authManager.initialize();
      const config = await authManager.getConfig();
      if (!config) {
        error('NOT_CONFIGURED', '尚未配置微信公众号信息');
        return;
      }
      success({
        appId: config.appId,
        appSecretMasked: config.appSecret.substring(0, 8) + '...',
        token: config.token || null,
        encodingAESKey: config.encodingAESKey || null,
      });
    } catch (e) {
      error('GET_CONFIG_FAILED', (e as Error).message);
    }
  });

// ============ PERMANENT-MEDIA 命令 ============
const mediaCmd = program.command('permanent-media').description('永久素材管理');

mediaCmd
  .command('add')
  .description('上传永久素材（封面图等）')
  .requiredOption('--type <type>', '素材类型: image, voice, video, thumb')
  .requiredOption('--file <filePath>', '本地文件路径')
  .option('--title <title>', '视频标题（video类型必需）')
  .option('--introduction <introduction>', '视频简介（video类型必需）')
  .action(async (options) => {
    try {
      const apiClient = await initApiClient();
      const { type, file: filePath, title, introduction } = options;

      if (!existsSync(filePath)) {
        error('FILE_NOT_FOUND', `文件不存在: ${filePath}`);
        return;
      }

      const fs = await import('fs');
      const mediaBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);

      const formData = new FormData();
      formData.append('media', mediaBuffer, fileName);

      if (type === 'video' && (title || introduction)) {
        const description = {
          title: title || '视频标题',
          introduction: introduction || '视频简介',
        };
        formData.append('description', JSON.stringify(description));
      }

      const result = (await apiClient.post(
        `/cgi-bin/material/add_material?type=${type}`,
        formData
      )) as { media_id: string; url?: string };

      success({
        mediaId: result.media_id,
        url: result.url || null,
        type,
        fileName,
      });
    } catch (e) {
      error('UPLOAD_PERMANENT_MEDIA_FAILED', (e as Error).message);
    }
  });

mediaCmd
  .command('count')
  .description('获取永久素材统计')
  .action(async () => {
    try {
      const apiClient = await initApiClient();
      const result = (await apiClient.get('/cgi-bin/material/get_materialcount')) as {
        image_count: number;
        voice_count: number;
        video_count: number;
        news_count: number;
      };
      success({
        imageCount: result.image_count,
        voiceCount: result.voice_count,
        videoCount: result.video_count,
        newsCount: result.news_count,
      });
    } catch (e) {
      error('GET_MATERIAL_COUNT_FAILED', (e as Error).message);
    }
  });

// ============ UPLOAD-IMG 命令 ============
program
  .command('upload-img')
  .description('上传图文消息图片（不占用素材库限制）')
  .requiredOption('--file <filePath>', '图片文件路径')
  .action(async (options) => {
    try {
      const apiClient = await initApiClient();
      const { file: filePath } = options;

      if (!existsSync(filePath)) {
        error('FILE_NOT_FOUND', `文件不存在: ${filePath}`);
        return;
      }

      const fs = await import('fs');
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).toLowerCase();

      // 检查文件大小（1MB限制）
      if (fileBuffer.length > 1024 * 1024) {
        error('FILE_TOO_LARGE', '文件大小不能超过1MB');
        return;
      }

      // 检查文件格式
      if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
        error('INVALID_FORMAT', '仅支持 jpg/png 格式的图片');
        return;
      }

      const formData = new FormData();
      formData.append('media', fileBuffer, {
        filename: fileName,
        contentType: ext === '.png' ? 'image/png' : 'image/jpeg',
      });

      const response = (await apiClient.post('/cgi-bin/media/uploadimg', formData)) as {
        url: string;
        errcode?: number;
        errmsg?: string;
      };

      if (response.errcode && response.errcode !== 0) {
        error('WECHAT_API_ERROR', `${response.errmsg} (${response.errcode})`);
        return;
      }

      success({
        url: response.url,
        fileName,
        size: fileBuffer.length,
        format: ext.substring(1),
      });
    } catch (e) {
      error('UPLOAD_IMG_FAILED', (e as Error).message);
    }
  });

// ============ DRAFT 命令 ============
const draftCmd = program.command('draft').description('草稿管理');

draftCmd
  .command('add')
  .description('创建草稿')
  .requiredOption('--title <title>', '文章标题')
  .requiredOption('--thumb-media-id <thumbMediaId>', '封面图片媒体ID')
  .option('--content <content>', 'HTML 内容')
  .option('--content-file <contentFile>', 'HTML 内容文件路径（优先于 --content）')
  .option('--author <author>', '作者')
  .option('--digest <digest>', '摘要')
  .option('--content-source-url <contentSourceUrl>', '原文链接')
  .option('--need-open-comment <needOpenComment>', '是否开启评论 (0/1)', '0')
  .option('--only-fans-can-comment <onlyFansCanComment>', '是否仅粉丝可评论 (0/1)', '0')
  .action(async (options) => {
    try {
      const apiClient = await initApiClient();

      let content = options.content;
      if (options.contentFile) {
        if (!existsSync(options.contentFile)) {
          error('FILE_NOT_FOUND', `内容文件不存在: ${options.contentFile}`);
          return;
        }
        content = readFileSync(options.contentFile, 'utf-8');
      }
      
      if (!content) {
        error('MISSING_CONTENT', '必须提供 --content 或 --content-file');
        return;
      }

      const result = (await apiClient.post('/cgi-bin/draft/add', {
        articles: [
          {
            title: options.title,
            author: options.author || '',
            digest: options.digest || '',
            content,
            content_source_url: options.contentSourceUrl || '',
            thumb_media_id: options.thumbMediaId,
            show_cover_pic: 0,
            need_open_comment: parseInt(options.needOpenComment) || 0,
            only_fans_can_comment: parseInt(options.onlyFansCanComment) || 0,
          },
        ],
      })) as { media_id: string };

      success({
        mediaId: result.media_id,
        title: options.title,
        message: '草稿创建成功',
      });
    } catch (e) {
      error('CREATE_DRAFT_FAILED', (e as Error).message);
    }
  });

draftCmd
  .command('list')
  .description('获取草稿列表')
  .option('--offset <offset>', '偏移量', '0')
  .option('--count <count>', '数量', '20')
  .action(async (options) => {
    try {
      const apiClient = await initApiClient();
      const result = (await apiClient.post('/cgi-bin/draft/batchget', {
        offset: parseInt(options.offset),
        count: parseInt(options.count),
      })) as {
        total_count: number;
        item: Array<{
          media_id: string;
          content: {
            news_item: Array<{ title: string; author: string }>;
            create_time: number;
            update_time: number;
          };
        }>;
      };

      success({
        totalCount: result.total_count,
        items: result.item.map((item) => ({
          mediaId: item.media_id,
          title: item.content.news_item[0]?.title,
          author: item.content.news_item[0]?.author,
          articleCount: item.content.news_item.length,
          createTime: new Date(item.content.create_time * 1000).toISOString(),
          updateTime: new Date(item.content.update_time * 1000).toISOString(),
        })),
      });
    } catch (e) {
      error('LIST_DRAFT_FAILED', (e as Error).message);
    }
  });

draftCmd
  .command('count')
  .description('获取草稿总数')
  .action(async () => {
    try {
      const apiClient = await initApiClient();
      const result = (await apiClient.post('/cgi-bin/draft/count')) as { total_count: number };
      success({ totalCount: result.total_count });
    } catch (e) {
      error('COUNT_DRAFT_FAILED', (e as Error).message);
    }
  });

// ============ MCP 命令（保留原有功能）============
program
  .command('mcp')
  .description('Start WeChat MCP server')
  .option('-a, --app-id <appId>', 'WeChat App ID')
  .option('-s, --app-secret <appSecret>', 'WeChat App Secret')
  .option('-m, --mode <mode>', 'Transport mode (stdio|sse)', 'stdio')
  .option('-p, --port <port>', 'Port for SSE mode', '3000')
  .action(async (options) => {
    const { appId, appSecret, mode, port } = options;

    if (!appId || !appSecret) {
      logger.error('App ID and App Secret are required');
      logger.info('Usage: npx wechat-mcp mcp -a <app_id> -s <app_secret>');
      process.exit(1);
    }

    const serverOptions: McpServerOptions = {
      appId,
      appSecret,
      mode: mode as 'stdio' | 'sse',
      port: port,
    };

    try {
      logger.info(`Starting WeChat MCP Server in ${mode} mode...`);
      logger.info(`App ID: ${appId}`);

      await initMcpServerWithTransport(serverOptions);
    } catch (e) {
      logger.error(`Failed to start MCP server: ${e}`);
      process.exit(1);
    }
  });

program.parse();
