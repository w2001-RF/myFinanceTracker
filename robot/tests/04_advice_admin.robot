*** Settings ***
Documentation     Advice tab (insights, monthly AI advice opt-in) and the owner console.
Resource          ../resources/common.resource
Suite Setup       Open Test Browser
Suite Teardown    Close All Browsers
Test Setup        Reset App
Test Timeout      60s
Force Tags        advice    admin

*** Test Cases ***
Insights Warn When Spending Exceeds Income
    Log In Successfully
    Add Transaction    Salary    income    1000
    Add Transaction    Rent    expense    1500
    Open Tab    advice
    Wait Until Element Contains    id:insightList    Spending exceeds income

Insights Ask For Data When There Is None
    Log In Successfully
    Open Tab    advice
    Wait Until Element Contains    id:insightList    Add your first transactions

Monthly AI Advice Is Off Until The User Opts In
    Log In Successfully
    Open Tab    advice
    Checkbox Should Not Be Selected    id:aiOptIn
    Wait Until Element Contains    id:aiAdvice    Turn on

Opting In Asks For Consent And Shares Only The Anonymous Summary
    Log In Successfully
    Add Transaction    Salary    income    1000
    Add Transaction    Secret client payment    expense    300
    Open Tab    advice
    Click Element    id:aiOptIn
    ${message}=    Accept Dialog
    Should Contain    ${message}    Not shared
    Toast Should Say    Monthly AI advice turned on
    ${rows}=    Mock Table    ai_advice_settings
    ${summary}=    Evaluate    __import__('json').dumps($rows)
    Should Contain    ${summary}    "enabled": true
    Should Not Contain    ${summary}    Secret client payment
    Should Not Contain    ${summary}    Salary
    Should Not Contain    ${summary}    ${USER_EMAIL}

Declining Consent Keeps The Monthly AI Advice Off
    Log In Successfully
    Add Transaction    Salary    income    1000
    Open Tab    advice
    Click Element    id:aiOptIn
    Dismiss Dialog
    Wait Until Keyword Succeeds    5x    0.3s    Checkbox Should Not Be Selected    id:aiOptIn
    ${rows}=    Mock Table    ai_advice_settings
    Should Be Empty    ${rows}

The Latest Saved Advice Is Shown And Can Be Deleted
    Log In Successfully
    Execute Javascript    window.__mock.seed('ai_advice_cache', [{user_id: 'u-user', period: '2026-10', advice: '- **Save more**: aim for 500 DHS a month\\n- Review subscriptions', created_at: '2026-10-02T06:00:00Z'}]);
    Open Tab    advice
    Click Button    id:aiAdviceBtn
    Wait Until Element Contains    id:aiAdvice    Save more
    Element Should Contain    id:aiMeta    2026-10
    Click Button    id:aiDeleteBtn
    Accept Dialog
    Wait Until Element Is Not Visible    id:aiAdvice
    ${rows}=    Mock Table    ai_advice_cache
    Should Be Empty    ${rows}

Ordinary Users Never See The Owner Console
    Log In Successfully
    Element Should Not Be Visible    id:adminTab

The Owner Sees The Console And Aggregate Counts Only
    Log In Successfully    ${OWNER_EMAIL}
    Wait Until Element Is Visible    id:adminTab
    Open Tab    admin
    Wait Until Element Contains    id:adminTotalAccounts    3
    Page Should Not Contain    ${USER_EMAIL}

The Owner Can Publish An Announcement That Everyone Sees
    Log In Successfully    ${OWNER_EMAIL}
    Open Tab    admin
    Input Text    id:adminAnnouncement    Scheduled maintenance on Sunday
    Click Button    id:adminSubmit
    Toast Should Say    Settings saved
    Element Should Be Visible    id:announcement
    Log Out
    Element Text Should Be    id:announcement    Scheduled maintenance on Sunday

Closing Sign-ups Hides The Create Account Button
    Log In Successfully    ${OWNER_EMAIL}
    Open Tab    admin
    Click Element    id:adminSignups
    Click Button    id:adminSubmit
    Toast Should Say    Settings saved
    Log Out
    Element Should Not Be Visible    id:registerBtn

Maintenance Mode Blocks Ordinary Users But Not The Owner
    Execute Javascript    window.__mock.setSetting('app_settings', {maintenance_mode: true, maintenance_message: 'Back at 6pm'});
    Go To    ${BASE_URL}/index.html
    Wait Until Element Is Visible    id:authScreen
    Login As    ${USER_EMAIL}
    Wait Until Element Is Visible    id:maintenanceScreen
    Element Text Should Be    id:maintenanceText    Back at 6pm
    Element Should Not Be Visible    id:mainApp
    Click Button    css:#maintenanceScreen button
    Wait Until Element Is Visible    id:authScreen
    Log In Successfully    ${OWNER_EMAIL}
    Element Should Not Be Visible    id:maintenanceScreen

The Owner Sees Model Health, Latency And Token Usage
    Log In Successfully    ${OWNER_EMAIL}
    Open Tab    admin
    Wait Until Element Contains    id:aiSuccessRate    83%
    Element Text Should Be    id:aiTokensIn    4,800
    Element Text Should Be    id:aiTokensOut    2,400
    Element Text Should Be    id:aiFallbackCalls    3
    Element Should Contain    id:aiModelTable    llama-3.3-70b-versatile
    Element Should Contain    id:aiModelTable    1,500
    Element Should Contain    id:aiErrorTable    Rate limited
    Element Should Contain    id:aiLastRun    stopped early

The Owner Can Change The Models And Test Them
    Log In Successfully    ${OWNER_EMAIL}
    Open Tab    admin
    Wait Until Element Is Visible    id:aiPrimaryModel
    Input Text    id:aiPrimaryModel    openai/gpt-oss-20b
    Input Text    id:aiFallbackModel    llama-3.1-8b-instant
    Click Button    id:aiModelSubmit
    Toast Should Say    Model settings saved
    ${rows}=    Mock Table    ai_model_settings
    ${primary}=    Evaluate    $rows[0]['primary_model']
    Should Be Equal    ${primary}    openai/gpt-oss-20b
    Click Button    id:aiHealthBtn
    Wait Until Element Is Visible    id:aiHealthResult
    Element Should Contain    id:aiHealthTable    OK
    Element Should Contain    id:aiHealthTable    420 ms
    Element Should Contain    id:aiHealthConfig    API key: set

Invalid Model Settings Are Rejected
    Log In Successfully    ${OWNER_EMAIL}
    Open Tab    admin
    Wait Until Element Is Visible    id:aiPrimaryModel
    Input Text    id:aiPrimaryModel    not a valid name!
    Click Button    id:aiModelSubmit
    Dialog Should Say    Model names may only contain
