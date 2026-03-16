import { z } from "zod";
import { server } from "../instance.js";
import { sendCommandToFigma } from "../connection.js";
import { getFileComments, postFileComment, deleteFileComment } from "../figma_rest_api.js";

// Get Comments Tool
server.tool(
  "get_comments",
  "Get comments from a Figma file via REST API. Returns comment threads with user, message (as markdown), timestamp, and resolved status. Requires FIGMA_API_TOKEN with file_comments:read scope.",
  {
    fileKey: z
      .string()
      .describe("The Figma file key. Extract from a Figma URL: https://www.figma.com/design/<fileKey>/..."),
    nodeId: z.string().optional().describe("Optional node ID to filter comments pinned to a specific node"),
    includeResolved: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include resolved comments (default: false, only unresolved)"),
  },
  async ({ fileKey, nodeId, includeResolved }: any) => {
    try {
      const allComments = await getFileComments(fileKey, true);

      let comments = allComments;

      // Filter out resolved unless requested
      if (!includeResolved) {
        comments = comments.filter((c) => !c.resolved_at);
      }

      // Filter to specific node if requested (include replies to matching comments)
      if (nodeId) {
        const nodeComments = comments.filter((c) => c.client_meta && c.client_meta.node_id === nodeId);
        const nodeCommentIds = new Set(nodeComments.map((c) => c.id));
        // Include replies (comments whose parent_id matches a node comment)
        const replies = comments.filter((c) => c.parent_id && nodeCommentIds.has(c.parent_id));
        comments = [...nodeComments, ...replies];
      }

      // Format for readability
      const formatted = comments.map((c) => ({
        id: c.id,
        user: c.user.handle,
        message: c.message,
        createdAt: c.created_at,
        resolved: !!c.resolved_at,
        parentId: c.parent_id || null,
        nodeId: c.client_meta?.node_id || null,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: formatted.length, comments: formatted }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting comments: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Post Comment Tool
server.tool(
  "post_comment",
  "Post a comment on a Figma file via REST API. Can create a new top-level comment, reply to an existing thread, or pin a comment to a specific node. Requires FIGMA_API_TOKEN with file_comments:write scope.",
  {
    fileKey: z
      .string()
      .describe("The Figma file key. Extract from a Figma URL: https://www.figma.com/design/<fileKey>/..."),
    message: z.string().describe("The comment text to post"),
    commentId: z.string().optional().describe("ID of an existing comment to reply to (creates a thread reply)"),
    nodeId: z
      .string()
      .optional()
      .describe("Node ID to pin the comment to (only for new top-level comments, not replies)"),
  },
  async ({ fileKey, message, commentId, nodeId }: any) => {
    try {
      const opts: { commentId?: string; nodeId?: string } = {};
      if (commentId) opts.commentId = commentId;
      if (nodeId) opts.nodeId = nodeId;

      const result = await postFileComment(fileKey, message, opts);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              commentId: result.id,
              user: result.user.handle,
              message: result.message,
              createdAt: result.created_at,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error posting comment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Delete Comment Tool
server.tool(
  "delete_comment",
  "Delete a comment from a Figma file via REST API. Only the comment author (token owner) can delete their own comments. Requires FIGMA_API_TOKEN with file_comments:write scope.",
  {
    fileKey: z
      .string()
      .describe("The Figma file key. Extract from a Figma URL: https://www.figma.com/design/<fileKey>/..."),
    commentId: z.string().describe("The ID of the comment to delete"),
  },
  async ({ fileKey, commentId }: any) => {
    try {
      await deleteFileComment(fileKey, commentId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, deletedCommentId: commentId }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting comment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  `Get annotations from Figma nodes. Supports three modes:
- Single node: pass \`nodeId\` to get annotations from one node and its subtree
- Batch: pass \`nodeIds\` array to check multiple nodes in one call (much more efficient than repeated single calls)
- Page scan: omit both to scan the entire current page

Categories are only included in the response when annotations are found. To discover all annotated nodes in a subtree, use \`find(hasAnnotation: true)\` instead — it searches an entire page in one call. Use \`get_annotations\` only when you already know which node IDs to read annotations from. Supports batch reads via the \`nodeIds\` array parameter.`,
  {
    nodeId: z.string().optional().describe("Single node ID to get annotations for (includes subtree)"),
    nodeIds: z
      .array(z.string())
      .optional()
      .describe("Array of node IDs to batch-check for annotations (more efficient than repeated single calls)"),
    includeCategories: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to include category information when annotations are found"),
  },
  async ({ nodeId, nodeIds, includeCategories }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        nodeIds,
        includeCategories,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z
      .string()
      .optional()
      .describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z
      .array(
        z.object({
          type: z.string(),
        }),
      )
      .optional()
      .describe("Additional properties for the annotation"),
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z.string().describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z
            .string()
            .optional()
            .describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z
            .array(
              z.object({
                type: z.string(),
              }),
            )
            .optional()
            .describe("Additional properties for the annotation"),
        }),
      )
      .min(1)
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter((item) => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults
          .map((item) => `- ${item.nodeId}: ${item.error || "Unknown error"}`)
          .join("\n")}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);
