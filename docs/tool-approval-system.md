# Tool Approval System

The tool approval system allows agents to request permission before using sensitive tools or performing potentially destructive actions.

## How It Works

1. **Agent Requests Approval**: When an agent needs to use a sensitive tool, it calls `request_tool_approval` instead of the tool directly.

2. **User Gets Notification**: The request appears as an urgent notification in the notification center with approve/deny buttons.

3. **User Decides**: The user can approve or deny the request, optionally providing a reason for denial.

4. **Agent Continues**: Once approved, the agent can proceed with the original tool call. If denied, the agent receives the denial reason and must find an alternative approach.

## For Agents

To request tool approval in your agent code:

```
I need to delete some files to clean up the workspace. Let me request approval first.

**Tool Use: request_tool_approval**
- tool_name: "bash"
- tool_input: {"command": "rm -rf temp_files/", "description": "Remove temporary files"}
- justification: "Cleaning up temporary files that are no longer needed to free disk space"
```

The system will pause execution until the user approves or denies the request.

## For Users

When an agent requests tool approval:

1. You'll see an urgent notification in the top-left notification center
2. The notification shows:
   - Agent name and the tool they want to use
   - The input parameters they want to pass to the tool
   - Their justification for using the tool
3. Click **Approve** to allow the action
4. Click **Deny** to reject it (you can optionally provide a reason)

## Tool Approval Database

The system tracks all tool approval requests with:
- Request timestamp
- Agent and office information
- Tool name and input parameters
- Approval/denial status
- Who approved/denied the request
- Reason for denial (if applicable)

## Configuration

Currently, tool approval is available to all agents through the `request_tool_approval` tool. Agents should use this for any potentially sensitive operations like:
- File system modifications
- Network requests to external services
- Database modifications
- Deployment actions
- System configuration changes

## API Endpoints

- `GET /api/tool-approvals` - List pending tool approvals
- `POST /api/tool-approvals/[id]/resolve` - Approve or deny a specific request
- Tool approval events are integrated into the notifications system