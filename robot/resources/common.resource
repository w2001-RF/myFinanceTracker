*** Settings ***
Documentation     Shared variables and keywords for the end-to-end tests.
...               The tests drive the real index.html in a real browser, with a fake in-browser Supabase
...               (robot/fixtures/mock-supabase.js), so no backend, network or real account is needed.
Library           SeleniumLibrary    timeout=10s    implicit_wait=0s
Library           Collections
Library           ${CURDIR}${/}StaticServer.py

*** Variables ***
${BROWSER}        headlesschrome
${SITE_DIR}       ${CURDIR}${/}..${/}.site
${BASE_URL}       http://127.0.0.1:0
${USER_EMAIL}     user@example.com
${OWNER_EMAIL}    owner@example.com
${LEGACY_EMAIL}   legacy@example.com
${PASSWORD}       correct-horse-battery
${LEGACY_PASSWORD}    abc

*** Keywords ***
# ---------------------------------------------------------------- server & browser
Start Test Server
    [Documentation]    Serves robot/.site on a free port and stores the address in ${BASE_URL}.
    ${port}=    Start Static Server    ${SITE_DIR}
    Set Global Variable    ${BASE_URL}    http://127.0.0.1:${port}
    Wait Until Keyword Succeeds    20x    0.5s    Server Should Respond

Server Should Respond
    ${status}=    Evaluate    __import__('urllib.request').request.urlopen('${BASE_URL}/index.html', timeout=2).status
    Should Be Equal As Integers    ${status}    200

Stop Test Server
    Stop Static Server

Open Test Browser
    [Arguments]    ${url}=${BASE_URL}/index.html
    # unhandledPromptBehavior=ignore: the app uses alert()/confirm(); the tests answer them explicitly.
    ${common}=    Set Variable    add_argument("--window-size=1280,900");set_capability("unhandledPromptBehavior", "ignore")
    IF    '${BROWSER}' == 'headlesschrome'
        Open Browser    ${url}    headlesschrome    options=${common};add_argument("--no-sandbox");add_argument("--disable-dev-shm-usage")
    ELSE IF    '${BROWSER}' == 'edge'
        Open Browser    ${url}    edge    options=${common};add_argument("--headless=new");add_argument("--no-sandbox");add_argument("--disable-gpu");add_argument("--disable-dev-shm-usage")
    ELSE
        Open Browser    ${url}    ${BROWSER}    options=${common}
    END

Reset App
    [Documentation]    Fresh data and a signed-out session before every test.
    Go To    ${BASE_URL}/index.html
    Execute Javascript    window.__mock.reset(); localStorage.clear(); sessionStorage.clear();
    Go To    ${BASE_URL}/index.html
    Wait Until Element Is Visible    id:authScreen

# ---------------------------------------------------------------- dialogs
Accept Dialog
    [Documentation]    Accepts the open alert()/confirm() and returns its text.
    ${message}=    Handle Alert    ACCEPT    timeout=5s
    RETURN    ${message}

Dismiss Dialog
    ${message}=    Handle Alert    DISMISS    timeout=5s
    RETURN    ${message}

Dialog Should Say
    [Arguments]    ${expected}
    ${message}=    Accept Dialog
    Should Contain    ${message}    ${expected}

# ---------------------------------------------------------------- auth
Login As
    [Arguments]    ${email}    ${password}=${PASSWORD}
    Input Text    id:authEmail    ${email}
    Input Password    id:authPassword    ${password}
    Click Button    id:loginBtn

Log In Successfully
    [Arguments]    ${email}=${USER_EMAIL}    ${password}=${PASSWORD}
    Login As    ${email}    ${password}
    Wait Until Element Is Visible    id:mainApp

Log Out
    Click Button    css:#mainApp .user-section button
    Wait Until Element Is Visible    id:authScreen

# ---------------------------------------------------------------- navigation
Open Tab
    [Arguments]    ${panel}
    Click Element    css:.tab[aria-controls="${panel}"]
    Wait Until Element Is Visible    id:${panel}

Toast Should Say
    [Arguments]    ${text}
    Wait Until Element Contains    id:toasts    ${text}

# ---------------------------------------------------------------- cash flow
Add Transaction
    [Arguments]    ${description}    ${type}    ${amount}
    Open Tab    general
    Input Text    id:generalDesc    ${description}
    Select From List By Value    id:generalType    ${type}
    Input Text    id:generalAmount    ${amount}
    Click Button    id:generalSubmit
    Wait Until Page Contains Element    xpath://table[@id='generalTable']//tr[td[normalize-space()='${description}']]

Transaction Row
    [Arguments]    ${description}
    RETURN    xpath://table[@id='generalTable']//tr[td[normalize-space()='${description}']]

# ---------------------------------------------------------------- mock data helpers
Mock Table
    [Arguments]    ${name}
    ${rows}=    Execute Javascript    return window.__mock.table('${name}');
    RETURN    ${rows}
