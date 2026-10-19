*** Settings ***
Documentation     Income vs expenses: adding, editing, deleting, filtering and quick transactions.
Resource          ../resources/common.resource
Suite Setup       Open Test Browser
Suite Teardown    Close All Browsers
Test Setup        Start Signed In
Test Timeout      60s
Force Tags        cashflow

*** Keywords ***
Start Signed In
    Reset App
    Log In Successfully

*** Test Cases ***
Adding Income And An Expense Updates The Totals
    Add Transaction    Salary    income    1000
    Add Transaction    Groceries    expense    250.50
    Wait Until Element Contains    id:totalIncome    1000.00 DHS
    Wait Until Element Contains    id:totalExpenses    250.50 DHS
    Wait Until Element Contains    id:netBalance    749.50 DHS
    Toast Should Say    Transaction added

An Invalid Amount Is Rejected With A Message
    Open Tab    general
    Input Text    id:generalDesc    Broken
    Input Text    id:generalAmount    0
    Click Button    id:generalSubmit
    Dialog Should Say    greater than 0
    Page Should Not Contain Element    xpath://table[@id='generalTable']//td[normalize-space()='Broken']

A Blank Description Is Rejected
    Open Tab    general
    Input Text    id:generalAmount    25
    Click Button    id:generalSubmit
    Dialog Should Say    fill all fields

Editing A Transaction Updates It Instead Of Adding Another
    Add Transaction    Salary    income    1000
    Click Button    xpath://table[@id='generalTable']//tr[td[normalize-space()='Salary']]//button[contains(@class,'edit-btn')]
    Wait Until Element Contains    id:generalSubmit    Update Transaction
    Input Text    id:generalAmount    1200
    Click Button    id:generalSubmit
    Wait Until Element Contains    id:totalIncome    1200.00 DHS
    Toast Should Say    Transaction updated
    ${rows}=    Get Element Count    css:#generalTable tbody tr
    Should Be Equal As Integers    ${rows}    1
    Element Should Contain    id:generalSubmit    Add Transaction

Cancelling An Edit Leaves The Transaction Unchanged
    Add Transaction    Salary    income    1000
    Click Button    xpath://table[@id='generalTable']//tr[td[normalize-space()='Salary']]//button[contains(@class,'edit-btn')]
    Click Button    id:generalCancel
    Element Should Contain    id:totalIncome    1000.00 DHS
    Element Should Contain    id:generalSubmit    Add Transaction

Deleting A Transaction Needs Confirmation
    Add Transaction    Salary    income    1000
    Click Button    xpath://table[@id='generalTable']//tr[td[normalize-space()='Salary']]//button[contains(@class,'delete-btn')]
    Dismiss Dialog
    Page Should Contain Element    xpath://table[@id='generalTable']//td[normalize-space()='Salary']
    Click Button    xpath://table[@id='generalTable']//tr[td[normalize-space()='Salary']]//button[contains(@class,'delete-btn')]
    Accept Dialog
    Wait Until Page Does Not Contain Element    xpath://table[@id='generalTable']//td[normalize-space()='Salary']
    Wait Until Element Contains    id:totalIncome    0.00 DHS

Searching And Filtering Narrow The Table But Not The Totals
    Add Transaction    Salary    income    1000
    Add Transaction    Groceries    expense    200
    Add Transaction    Gym    expense    50
    Input Text    id:generalSearch    gro
    Wait Until Keyword Succeeds    5x    0.3s    Visible Transaction Rows Should Be    1
    Input Text    id:generalSearch    ${EMPTY}
    Select From List By Value    id:generalFilterType    expense
    Wait Until Keyword Succeeds    5x    0.3s    Visible Transaction Rows Should Be    2
    Element Should Contain    id:generalCount    Showing 2 of 3
    Element Should Contain    id:totalIncome    1000.00 DHS

A Quick Transaction Can Be Saved And Added In One Tap
    Open Tab    general
    Input Text    id:generalDesc    Coffee
    Select From List By Value    id:generalType    expense
    Input Text    id:generalAmount    15
    Click Button    id:saveTemplateBtn
    Wait Until Element Contains    id:templateList    Coffee
    Click Button    css:#templateList .chip-main
    Wait Until Page Contains Element    xpath://table[@id='generalTable']//td[normalize-space()='Coffee']
    Wait Until Element Contains    id:totalExpenses    15.00 DHS

A Quick Transaction Can Be Deleted
    Open Tab    general
    Input Text    id:generalDesc    Coffee
    Input Text    id:generalAmount    15
    Click Button    id:saveTemplateBtn
    Wait Until Element Contains    id:templateList    Coffee
    Click Button    css:#templateList .chip-aux[title="Delete"]
    Accept Dialog
    Wait Until Element Does Not Contain    id:templateList    Coffee

Transactions Can Be Exported As CSV Only When There Is Data
    Open Tab    general
    Click Button    xpath://button[contains(.,'Export CSV')]
    Toast Should Say    Nothing to export

*** Keywords ***
Visible Transaction Rows Should Be
    [Arguments]    ${expected}
    ${count}=    Get Element Count    css:#generalTable tbody tr:not(.empty-row)
    Should Be Equal As Integers    ${count}    ${expected}
