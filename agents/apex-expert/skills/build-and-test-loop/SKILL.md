---
name: Build and test loop (Analyst, Developer, Tester)
description: Use when the user asks to build a new APEX application, or to make a change to an existing app that spans several pages or needs new tables - anything bigger than a small edit you can do yourself. Runs the team - Analyst writes the technical requirement, user confirms, Developer builds and installs, Tester tests - through delegate_subagent, up to 3 fix rounds. Not for questions, inspections or one-page edits.
---
## Overview
Orchestrate a build: you do not write the spec or the app yourself. You create the project, hand each step to the right sub-agent with complete context, keep the user in the loop at the spec, and report the outcome. Delegating these steps to the saved sub-agents is the intended design here, not a pass-through.

## Inputs
- The user's requirement (in their words), and for a change the application id.
- The sub-agent ids are listed in the delegate_subagent tool description: APEX Analyst, APEX Developer, APEX Tester. Never use "inline" for these steps.

## Steps
1. Project:
   - new app: New_Project (scaffold) -> PROJECT key.
   - change to app N: New_Project with mode "empty", then Export_App(session, app_id N).
2. Analyst: delegate_subagent(subAgentId = Analyst id, goal = "Write the technical requirement spec.md for this APEX app requirement", context = the user's requirement verbatim + "Project (session): <key>" + for a change "Existing application <N> exported under app/" + anything the user said about users, roles, data, look, expectedOutput = "Summary with Spec, Open Questions, Assumptions; spec.md written in the project").
3. Show the user the spec summary, the assumptions and the open questions; FS_Read spec.md if they want details. In the same message ask whether they want sample data: "Should I also generate sample data (about 25 rows per table) after the install, so the app can be tested with realistic data?" (for a change to an existing app, add that the rows go into the tables the live app uses). Then END YOUR TURN and wait for their answer -- also when there are no open questions: the user confirms every spec before anything is built. If they answer questions or ask for changes, delegate to the Analyst again with the answers and "revise spec.md". Continue only when the user confirms (or tells you to go ahead with the assumptions). No answer on sample data counts as no.
4. Developer: delegate_subagent(subAgentId = Developer id, goal = "Build the APEX app described in spec.md and install it" (round 1) or "Fix the Tester's findings and reinstall" (rounds 2-3), context = "Project (session): <key>", the application id once known, "Sample data: yes (<amount>)" or "Sample data: no" (round 1 only; it is loaded once), for a fix round the Tester's Findings verbatim, expectedOutput = "Files Written, Findings Addressed, Check and Install (Check_App result, application id), Sample Data (rows per table, or not requested), Open Issues"). The user approves the Developer's Install_App and SQL_Execute calls in the chat.
5. Gate before testing: the Developer's answer must report Check_App PASSED and an installed application id. If not, and rounds remain, send it back with the errors; do not test an app that does not compile.
6. Tester: delegate_subagent(subAgentId = Tester id, goal = "Test application <id> against spec.md", context = "Project (session): <key>", "Application id: <id>", "Sample data loaded: <rows per table>" or "No sample data", for rounds 2-3 "Re-test everything; previous findings were: ...", expectedOutput = "Results per AC, Findings, Verdict PASS or FAIL as the last line").
7. Verdict PASS -> report to the user. FAIL -> next Developer round with the findings (step 4). At most 3 Developer rounds in total; after the third FAIL, stop and report what passes, what fails and what you recommend.
8. Report: application id, name and URL @@APEX_APP_URL@@<alias lower case>/, pages built, the Tester's results (AC pass/fail), the sample data loaded (rows per table, and test-data/delete-sample-data.sql to remove it), open issues, project key.

## Rules
- Sub-agents cannot see this chat: every delegation carries all context it needs (project key, app id, requirement or findings verbatim).
- One delegation at a time; wait for its result before the next.
- Pass the sub-agents' findings and errors verbatim; do not summarise away file names or messages.
- Do not mark the build done without a Tester PASS (or the user's explicit decision to stop).
- If a sub-agent reports UNAVAILABLE (SQLcl, ORDS), stop the loop and tell the user; do not continue on offline checks.

## Example
User: "Build me a small app to track customer complaints with status and assignee." -> New_Project -> PROJECT 3fa21c09 -> Analyst -> spec: 2 tables, IR page 2, modal form page 3, dashboard page 1, 9 ACs, 2 open questions -> you show the summary, the questions and the sample-data question -> user answers, "yes, sample data" -> Analyst revises -> user: "go" -> Developer (Sample data: yes, about 25 rows per table): Check_App PASSED, Install_App approved, application 131, 25 complaints loaded -> Tester: AC-7 FAIL (status filter missing) -> Developer round 2 -> Tester PASS -> report with URL.

## Gotchas
- The first Install_App of a new project creates the application id; give that id to the Tester and to later Developer rounds.
- If the user rejects an Install_App approval, the Developer stops; ask the user how to continue instead of re-delegating the same step.
- Long builds: the Developer may take many minutes; that is normal.
